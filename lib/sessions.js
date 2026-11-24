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
    const bindings = await this.registry.all()
    const worker = async (route) => {
      const known = bindings.filter((row) => row.route === route)
      if (options.passive) return {
        route, displayName: this.profile(route).displayName, capabilities: [], passive: true,
        sessions: known.map((row) => ({ sessionId: row.binding.externalSessionId, dshSessionId: row.dshSessionId,
          cwd: row.binding.cwd, model: row.binding.model, requestedModel: row.binding.requestedModel, forkedFrom: row.binding.forkedFrom,
          updatedAt: new Date(row.binding.lastPromptAt || 0).toISOString() })),
      }
      try { return await this.list(route, options) }
      catch (error) {
        return { route, displayName: this.profile(route).displayName, capabilities: [], sessions: [], error: error.message }
      }
    }
    const routes = this.routes()
    // Bound probes without serializing every healthy agent behind one failing route.
    for (let i = 0; i < routes.length; i += 3) rows.push(...await Promise.all(routes.slice(i, i + 3).map(worker)))
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
    this.assertIdle(request.dshSessionId, request.route)
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
      ...binding.toRecord(),
      externalSessionId: forked,
      forkedFrom: binding.externalSessionId,
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
    const owner = (await this.registry.all()).find((row) => row.route === route && row.binding.externalSessionId === externalId)
    if (owner) this.assertIdle(owner.dshSessionId, route)
    const cwd = options.cwd ?? owner?.binding.cwd
    const transport = await this.transport(profile, cwd)
    await transport.closeSession(externalId, {
      cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    await this.dropBindings(route, externalId)
    return { route, sessionId: externalId, closed: true }
  }

  /** Permanently remove one stored session. */
  async delete(route, externalId, options = {}) {
    const profile = this.profile(route)
    const owner = (await this.registry.all()).find((row) => row.route === route && row.binding.externalSessionId === externalId)
    if (owner) this.assertIdle(owner.dshSessionId, route)
    const cwd = options.cwd ?? owner?.binding.cwd
    const transport = await this.transport(profile, cwd)
    if (!supports(transport, CAPABILITY.DELETE)) {
      throw new SessionAdminError(`agent "${route}" cannot delete sessions`, 'UNSUPPORTED')
    }
    await transport.deleteSession(externalId, {
      cwd,
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

  assertIdle(dshSessionId, route) {
    if (this.adapter.isBusy?.(dshSessionId, route)) throw new SessionAdminError('stop the active turn before changing its session', 'BUSY')
  }

  async cancel(dshSessionId, route, runId) {
    this.profile(route)
    return { cancelled: this.adapter.cancel(dshSessionId, route, runId) }
  }

  async configure({ dshSessionId, route, configId, value }) {
    this.assertIdle(dshSessionId, route)
    const binding = await this.registry.get(dshSessionId, route)
    if (!binding) throw new SessionAdminError('send a message before configuring this session', 'NO_BINDING')
    const transport = await this.transport(this.profile(route), binding.cwd)
    if (transport.kind !== 'acp') throw new SessionAdminError('this backend has no live configuration channel', 'UNSUPPORTED')
    const session = await transport.resume(binding.externalSessionId, { cwd: binding.cwd })
    try {
      await session.setConfigOption(configId, value)
      await this.registry.set(dshSessionId, route, new SessionBinding({ ...binding.toRecord(),
        model: session.selectedModel, sessionConfig: { ...binding.sessionConfig, [configId]: value } }))
      await this.adapter.activity?.updateConfiguration(dshSessionId, route, session.configOptions)
      return { configOptions: session.configOptions }
    } finally { await session.close() }
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
