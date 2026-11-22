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

/** Locate the directory that holds this profile's durable state. */
function profileDir(ctx) {
  try {
    const dir = ctx.profileContext?.dir
    if (typeof dir === 'string' && dir.length > 0) return dir
  } catch {
    // A profile launched without the launcher supplies no profileContext.
  }
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
function makeResolveCwd(ctx) {
  const fallback = () => {
    try {
      const dir = ctx.workingDirectory?.defaultDirectory
      if (typeof dir === 'string' && dir.length > 0) return dir
    } catch {
      // The working-directory service is optional in a minimal composition.
    }
    return process.cwd()
  }
  return (sessionId) => {
    if (sessionId === undefined) return fallback()
    try {
      const agent = ctx.agents?.get?.(sessionId)
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // A cold or foreign session id simply has no agent record.
    }
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
function makeCredentials(ctx) {
  return {
    async resolve(ref) {
      // `ctx.get` is the optional-service accessor: a composition without a
      // credential store must read as "no value", not as a thrown TypeError.
      const service = ctx.get?.('credentials')
      if (service === undefined) return undefined
      try {
        const resolved = await service.resolve(credentialRef(ref))
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
  const registry = new SessionRegistry(profileDir(ctx))

  const adapter = new AgentProviderAdapter({
    current: () => ({ profiles: profiles(), maxReplayChars: config.maxReplayChars }),
    registry,
    resolveCwd: makeResolveCwd(ctx),
    credentials: makeCredentials(ctx),
    // Image bytes live in the attachment service, not in the message block.
    readImage: async (ref, signal) => {
      const attachments = ctx.get?.('attachments')
      if (attachments === undefined) throw new Error('this composition mounts no attachment service')
      return attachments.readImage(ref, signal)
    },
    // The harness resolves a bare command against the profile's own PATH rules
    // instead of whatever PATH this process happened to inherit.
    diagnostics: new LaunchDiagnostics(profileDir(ctx)),
    resolveExecutable: (command) => {
      const service = ctx.get?.('subprocess')
      if (service === undefined) return Promise.resolve(command)
      return service.resolveExecutable(command)
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

  ctx.on('loader/volatile-update', () => {
    try {
      ensure()
    } catch (error) {
      ctx.logger.error('dsh-agent-providers: could not apply the edited agent configuration')
      ctx.logger.error(error)
    }
  })

  const admin = new SessionAdmin({
    adapter,
    current: () => ({ profiles: profiles() }),
    registry,
    resolveCwd: makeResolveCwd(ctx),
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
