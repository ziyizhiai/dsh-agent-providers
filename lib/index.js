/**
 * Plugin entry: one LLM adapter, one provider route per configured agent.
 *
 * Wiring follows `dsh-llm-pi-ai`: a volatile `agents` dict is the live
 * configuration, the route set is structural, and an edit re-registers the
 * adapter's routes atomically without a restart. A bare mount (zero agents)
 * is a legitimate dormant posture — nothing registers until the profile or
 * the settings section supplies at least one agent.
 *
 * @module dsh-agent-providers
 */
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AgentProviderAdapter } from './adapter.js'
import { ActivityStore } from './activity.js'
import { Config, resolveAgent } from './config.js'
import { LaunchDiagnostics } from './diagnostics.js'
import { registerRoutes } from './http.js'
import { SessionRegistry } from './registry.js'
import { SessionAdmin } from './sessions.js'
import { registerTool } from './tools.js'

/** Loader row id; also the default settings namespace. */
const NS = 'llm-agent-providers'

/** Services this plugin cannot work without. */
export const inject = ['llm']

export { Config }

/** Resolve the raw `agents` record into detached, validated profiles. */
function resolveProfiles(raw) {
  const profiles = new Map()
  for (const [route, entry] of Object.entries(raw ?? {})) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`dsh-agent-providers: agent "${route}" is not an object`)
    }
    profiles.set(route, resolveAgent(route, entry))
  }
  return profiles
}

/**
 * Optional services, resolved without making them hard dependencies.
 *
 * A cordis context can only see services its fiber declared through `inject` —
 * `ctx.get(name)` and `ctx.<name>` both come from the fiber's isolate map, so an
 * undeclared service reads as absent even when the composition mounts it. These
 * five are genuinely optional (a minimal profile may have no approval channel,
 * no attachment store, no subprocess seam, no credential store, no agent
 * registry), so each is attached through `ctx.inject` and cached while its
 * provider is alive: present when mounted, `undefined` when not.
 *
 * Getting this wrong is silent by construction — credentials that never resolve,
 * images that never load, approvals that always read as unavailable — so the
 * accessor is the only way this module touches them.
 *
 * @param {any} ctx
 * @param {string[]} names
 * @returns {(name: string) => any}
 */
function makeServiceLens(ctx, names) {
  const available = new Map()
  for (const name of names) {
    ctx.inject([name], (child) => {
      available.set(name, child[name])
      child.effect(() => () => { available.delete(name) })
    })
  }
  return (name) => available.get(name)
}

/** Services this plugin uses when the composition provides them. */
const OPTIONAL_SERVICES = Object.freeze([
  'agents',
  'approval',
  'attachments',
  'credentials',
  'profileContext',
  'subprocess',
  'workingDirectory',
])

/** Locate the directory that holds this profile's durable state. */
function profileDir(ctx, service) {
  const dir = service('profileContext')?.dir
  if (typeof dir === 'string' && dir.length > 0) return dir
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (typeof home === 'string' && typeof profile === 'string') {
    return join(home, 'profiles', profile)
  }
  return join(home ?? process.cwd(), 'agent-providers')
}

/**
 * Resolve the working directory an agent should run in for one DSH Session.
 * The Session header is authoritative; anything unavailable falls back to the
 * harness default directory, then to the plugin process directory.
 */
function makeResolveCwd(service) {
  const fallback = () => {
    const dir = service('workingDirectory')?.defaultDirectory
    if (typeof dir === 'string' && dir.length > 0) return dir
    return process.cwd()
  }
  return (sessionId) => {
    if (sessionId === undefined) return fallback()
    const agent = service('agents')?.get?.(sessionId)
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
    return fallback()
  }
}

/**
 * Resolve child-environment secrets through the harness credential service.
 *
 * The reference names are the profile's own (usually an environment variable
 * name); the value comes from wherever DSH stores it, so an agent can reuse the
 * key an existing model provider already uses.
 */
function makeCredentials(service) {
  return {
    async resolve(ref) {
      const credentials = service('credentials')
      if (credentials === undefined) return undefined
      try {
        const resolved = await credentials.resolve(credentialRef(ref))
        return resolved?.value
      } catch {
        // A reference outside the credential grammar has nothing to resolve.
        return undefined
      }
    },
  }
}

/**
 * Mount the adapter.
 * @param {any} ctx - the Cordis context.
 * @param {any} config - the resolved plugin config.
 */
export function apply(ctx, config) {
  // Own the section so the Models settings page can edit it, mirroring pi-ai.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  const settingsNs = ctx.fiber?.entry?.options?.id ?? NS

  let lastRaw
  let cached
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity. A resolution failure keeps the previous good profile
   * set so a half-typed settings document cannot take the routes down.
   */
  const profiles = () => {
    const raw = config.agents.get()
    if (raw === lastRaw && cached !== undefined) return cached
    try {
      cached = resolveProfiles(structuredClone(raw))
      lastRaw = raw
    } catch (error) {
      if (cached === undefined) throw error
      lastRaw = raw
      ctx.logger.error('dsh-agent-providers: keeping the last good agent configuration')
      ctx.logger.error(error)
    }
    return cached
  }
  profiles()

  // One registry for the whole plugin: two instances would hold divergent
  // in-memory maps over the same file and clobber each other on write.
  const service = makeServiceLens(ctx, OPTIONAL_SERVICES)
  const stateDirectory = config.stateDirectory || profileDir(ctx, service)
  const registry = new SessionRegistry(stateDirectory)

  const adapter = new AgentProviderAdapter({
    current: () => ({ profiles: profiles(), maxReplayChars: config.maxReplayChars }),
    registry,
    activity: new ActivityStore(stateDirectory),
    resolveCwd: makeResolveCwd(service),
    credentials: makeCredentials(service),
    // Image bytes live in the attachment service, not in the message block.
    canReadImage: () => typeof service('attachments')?.readImage === 'function',
    readImage: async (ref, signal) => {
      const attachments = service('attachments')
      if (attachments === undefined) throw new Error('this composition mounts no attachment service')
      return attachments.readImage(ref, signal)
    },
    // The harness resolves a bare command against the profile's own PATH rules
    // instead of whatever PATH this process happened to inherit.
    diagnostics: new LaunchDiagnostics(stateDirectory),
    resolveExecutable: (command) => {
      const subprocess = service('subprocess')
      if (subprocess === undefined) return Promise.resolve(command)
      return subprocess.resolveExecutable(command)
    },
    // An agent that asks permission (`permission: 'ask'`) goes through the same
    // approval service a harness tool call uses, so the question reaches the
    // user's approval prompt and its audit trail. Resolved lazily: the service
    // may mount after this plugin, and a composition without one must read as
    // "unavailable" — the transport then fails closed.
    askApproval: async ({ sessionId, toolName, reason, displayReason, signal }) => {
      const approval = service('approval')
      if (approval === undefined) {
        // Say which seam is missing: an approval that silently reads as
        // unavailable looks exactly like a user saying no.
        ctx.logger?.error?.(
          `dsh-agent-providers: "${toolName}" needs approval but this composition mounts no approval service; denying`,
        )
        return 'unavailable'
      }
      const agent = sessionId === undefined ? undefined : service('agents')?.get?.(sessionId)
      if (agent === undefined) {
        ctx.logger?.error?.(
          `dsh-agent-providers: "${toolName}" needs approval but session "${sessionId}" has no live agent; denying`,
        )
        return 'unavailable'
      }
      return approval.request({
        agent,
        toolName,
        ...(reason === undefined ? {} : { reason }),
        ...(displayReason === undefined ? {} : { displayReason }),
        ...(signal === undefined ? {} : { signal }),
      })
    },
    logger: ctx.logger,
  })

  /** @type {{ replace(routes: string[]): void } | undefined} */
  let registration
  /** @type {{ replace(entries: any[]): void } | undefined} */
  let directory

  const ensure = () => {
    const map = profiles()
    const routes = [...map.keys()]
    if (registration === undefined) {
      if (routes.length > 0) registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    const entries = routes.map((route) => ({
      provider: route,
      displayName: map.get(route).displayName,
      settingsNs,
      settingsPath: ['agents', route],
    }))
    if (directory === undefined) {
      if (entries.length > 0) directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
  }

  try {
    ensure()
  } catch (error) {
    ctx.logger.error('dsh-agent-providers: configuration conflicts with an existing provider route')
    ctx.logger.error(error)
  }

  let reconcile = Promise.resolve()
  ctx.on('loader/volatile-update', () => {
    reconcile = reconcile.catch(() => {}).then(async () => {
      try { await adapter.reconcile(); ensure() }
      catch (error) { ctx.logger.error('dsh-agent-providers: could not apply the edited agent configuration'); ctx.logger.error(error) }
    })
  })

  const admin = new SessionAdmin({
    adapter,
    current: () => ({ profiles: profiles() }),
    registry,
    resolveCwd: makeResolveCwd(service),
    logger: ctx.logger,
  })

  // Session inventory for the sidebar: an HTTP resource the browser half reads.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => registerRoutes(scope, admin), 'agent-providers: session routes')
  })

  // The same operations for the model, so an agent can tidy up or branch its
  // own conversation without a human. Global and therefore opt-out.
  if (config.exposeTool !== false) {
    ctx.inject(['tools'], (scope) => {
      scope.effect(
        () => registerTool(scope, admin, config.toolName ?? 'agent_sessions'),
        'agent-providers: session tool',
      )
    })
  }

  ctx.effect(() => () => {
    void adapter.dispose()
  })
}
