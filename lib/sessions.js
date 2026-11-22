/**
 * Session administration: the inventory of external agent conversations and
 * the operations a human or the model can perform on them.
 *
 * This is requirement ④ — "manage their sessions from inside DSH". The
 * adapter owns turns; this owns everything around a turn: what exists, who it
 * belongs to, and how to branch or release one.
 *
 * Every operation is capability-gated. A transport that cannot list, fork or
 * delete says so through {@link CAPABILITY}, and this layer reports the
 * limitation instead of inventing a result.
 *
 * @module dsh-agent-providers/sessions
 */
import { SessionBinding } from './registry.js'
import { CAPABILITY, supports } from './transport/contract.js'

/** A failure the caller can show to a user as-is. */
export class SessionAdminError extends Error {
  constructor(message, code = 'AGENT_SESSION') {
    super(message)
    this.name = 'SessionAdminError'
    this.code = code
  }
}

export class SessionAdmin {
  /**
   * @param {object} dependencies
   * @param {import('./adapter.js').AgentProviderAdapter} dependencies.adapter
   * @param {() => { profiles: Map<string, any> }} dependencies.current
   * @param {import('./registry.js').SessionRegistry} dependencies.registry
   * @param {(sessionId?: string) => string} dependencies.resolveCwd
   * @param {{ error?: (...args: any[]) => void }} [dependencies.logger]
   */
  constructor({ adapter, current, registry, resolveCwd, logger }) {
    this.adapter = adapter
    this.current = current
    this.registry = registry
    this.resolveCwd = resolveCwd
    this.logger = logger
  }

  /** Provider routes this plugin currently serves. */
  routes() {
    return [...this.current().profiles.keys()]
  }

  /** Resolve one route or fail with the configured names. */
  profile(route) {
    const profile = this.current().profiles.get(route)
    if (profile === undefined) {
      const known = this.routes()
      throw new SessionAdminError(
        `unknown agent route "${route}"${known.length > 0 ? ` (configured: ${known.join(', ')})` : ''}`,
        'UNKNOWN_ROUTE',
      )
    }
    return profile
  }

  /** Transport for one route at that agent's own working directory. */
  async transport(profile, cwd) {
    return this.adapter.transportFor(profile, cwd ?? profile.cwd ?? this.resolveCwd(undefined))
  }

  /**
   * What one route can do, and its stored conversations.
   *
   * @param {string} route
   * @param {{ cwd?: string, signal?: AbortSignal }} [options]
   */
  async list(route, options = {}) {
    const profile = this.profile(route)
    const cwd = options.cwd ?? profile.cwd ?? this.resolveCwd(undefined)
    const transport = await this.transport(profile, cwd)
    const capabilities = [...transport.capabilities].sort()

    if (!supports(transport, CAPABILITY.LIST)) {
      return { route, displayName: profile.displayName, capabilities, sessions: [] }
    }
    const sessions = await transport.list({ cwd, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    const owners = new Map((await this.registry.all()).map((row) => [`${row.route}\u0000${row.binding.externalSessionId}`, row]))
    return {
      route,
      displayName: profile.displayName,
      capabilities,
      sessions: sessions.map((session) => {
        const owner = owners.get(`${route}\u0000${session.sessionId}`)
        return {
          ...session,
          ...(owner === undefined ? {} : { dshSessionId: owner.dshSessionId }),
        }
      }),
    }
  }

  /**
   * Every configured route's inventory. A route whose agent is unreachable
   * reports its error instead of failing the whole listing.
   */
  async inventory(options = {}) {
    const rows = []
    for (const route of this.routes()) {
      try {
        rows.push(await this.list(route, options))
      } catch (error) {
        this.logger?.error?.(`dsh-agent-providers: inventory for "${route}" failed: ${error.message}`)
        rows.push({
          route,
          displayName: this.current().profiles.get(route).displayName,
          capabilities: [],
          sessions: [],
          error: error.message,
        })
      }
    }
    return rows
  }

  /**
   * Branch the agent conversation bound to one DSH Session and rebind it, so
   * the next turn continues on the branch instead of the original.
   *
   * The rebind keeps the forwarded-turn witnesses, so the next request resumes
   * with `session/load` and the branch inherits the same history.
   *
   * @param {{ route: string, dshSessionId: string, cwd?: string, signal?: AbortSignal }} request
   * @returns {Promise<{ from: string, to: string }>}
   */
  async fork(request) {
    const profile = this.profile(request.route)
    const binding = await this.registry.get(request.dshSessionId, request.route)
    if (binding === undefined) {
      throw new SessionAdminError(
        'this conversation has no agent session yet; send one message first',
        'NO_BINDING',
      )
    }
    // The branch must happen in the working directory the conversation was
    // created in, not wherever the caller happens to be now.
    const cwd = request.cwd ?? binding.cwd ?? profile.cwd ?? this.resolveCwd(request.dshSessionId)
    const transport = await this.transport(profile, cwd)
    if (!supports(transport, CAPABILITY.FORK)) {
      throw new SessionAdminError(`agent "${request.route}" cannot fork sessions`, 'UNSUPPORTED')
    }
    const forked = await transport.fork(binding.externalSessionId, {
      cwd,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    await this.registry.set(request.dshSessionId, request.route, new SessionBinding({
      externalSessionId: forked,
      cwd: binding.cwd,
      sentUserCount: binding.sentUserCount,
      sentUserDigest: binding.sentUserDigest,
      model: binding.model,
      lastPromptAt: binding.lastPromptAt,
    }))
    return { from: binding.externalSessionId, to: forked }
  }

  /** Release one external session's resources; its history survives. */
  async close(route, externalId, options = {}) {
    const profile = this.profile(route)
    const transport = await this.transport(profile, options.cwd)
    await transport.closeSession(externalId, {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    await this.dropBindings(route, externalId)
    return { route, sessionId: externalId, closed: true }
  }

  /** Permanently remove one stored session. */
  async delete(route, externalId, options = {}) {
    const profile = this.profile(route)
    const transport = await this.transport(profile, options.cwd)
    if (!supports(transport, CAPABILITY.DELETE)) {
      throw new SessionAdminError(`agent "${route}" cannot delete sessions`, 'UNSUPPORTED')
    }
    await transport.deleteSession(externalId, {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    await this.dropBindings(route, externalId)
    return { route, sessionId: externalId, deleted: true }
  }

  /** The agent route bound to one DSH Session. */
  async routeForSession(dshSessionId) {
    for (const row of await this.registry.all()) {
      if (row.dshSessionId === dshSessionId) return row.route
    }
    throw new SessionAdminError(
      `this conversation (${dshSessionId}) is not bound to any agent session yet`,
      'NO_BINDING',
    )
  }

  /** Forget every DSH binding that pointed at one external session. */
  async dropBindings(route, externalId) {
    for (const row of await this.registry.all()) {
      if (row.route === route && row.binding.externalSessionId === externalId) {
        await this.registry.drop(row.dshSessionId, route)
      }
    }
  }
}
