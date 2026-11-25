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
  async withIdle(dshSessionId, route, action, signal) {
    this.assertIdle(dshSessionId, route)
    const release = await this.adapter.lock?.(dshSessionId, route, signal)
    try {
      if (this.adapter.activeRuns?.has(`${route}\u0000${dshSessionId}`)) throw new SessionAdminError('session is running', 'BUSY')
      return await action()
    } finally { release?.() }
  }

  async owner(route, externalId) {
    const active = [...(this.adapter.activeRuns?.values() ?? [])].find(run => run.profile.route === route && run.externalId === externalId)
    if (active) throw new SessionAdminError('stop the active turn before changing its session', 'BUSY')
    return (await this.registry.all()).find(row => row.route === route && row.binding.externalSessionId === externalId)
  }

  async fork(request) {
    return this.withIdle(request.dshSessionId, request.route, () => this.forkIdle(request), request.signal)
  }

  async forkIdle(request) {
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
    const owner = await this.owner(route, externalId)
    return this.withIdle(owner?.dshSessionId ?? `external:${externalId}`, route, () => this.closeIdle(route, externalId, options), options.signal)
  }
  async closeIdle(route, externalId, options = {}) {
    const profile = this.profile(route)
    const owner = await this.owner(route, externalId)
    const cwd = options.cwd ?? owner?.binding.cwd
    const transport = await this.transport(profile, cwd)
    if (!supports(transport, CAPABILITY.CLOSE)) throw new SessionAdminError('this backend has no close capability', 'UNSUPPORTED')
    await transport.closeSession(externalId, {
      cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    await this.dropBindings(route, externalId)
    return { route, sessionId: externalId, closed: true }
  }

  /** Permanently remove one stored session. */
  async delete(route, externalId, options = {}) {
    const owner = await this.owner(route, externalId)
    return this.withIdle(owner?.dshSessionId ?? `external:${externalId}`, route, () => this.deleteIdle(route, externalId, options), options.signal)
  }
  async deleteIdle(route, externalId, options = {}) {
    const profile = this.profile(route)
    const owner = await this.owner(route, externalId)
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

  async configure(request) {
    return this.withIdle(request.dshSessionId, request.route, () => this.configureIdle(request))
  }
  async configureIdle({ dshSessionId, route, configId, value }) {
    const binding = await this.registry.get(dshSessionId, route)
    if (!binding) throw new SessionAdminError('send a message before configuring this session', 'NO_BINDING')
    const transport = await this.transport(this.profile(route), binding.cwd)
    if (transport.kind !== 'acp' || !supports(transport, CAPABILITY.RESUME)) throw new SessionAdminError('this backend has no resumable configuration channel', 'UNSUPPORTED')
    if (binding.generation && binding.generation !== transport.generation) throw new SessionAdminError('account configuration changed; send a new turn first', 'STALE_SESSION')
    const session = await transport.resume(binding.externalSessionId, { cwd: binding.cwd })
    try {
      if (!supports(session, CAPABILITY.CONFIGURE)) throw new SessionAdminError('session options are not available', 'UNSUPPORTED')
      const option = session.configOptions.find(entry => entry.id === configId)
      if (option?.category === 'model' || option?.id === 'model') throw new SessionAdminError('use the model picker to change model', 'MODEL_PICKER')
      if (option?.type === 'boolean' && ['true', 'false'].includes(value)) value = value === 'true'
      await session.setConfigOption(configId, value)
      await this.registry.set(dshSessionId, route, new SessionBinding({ ...binding.toRecord(),
        model: session.selectedModel, configOptions: session.configOptions, capabilities: [...session.capabilities],
        sessionConfig: { ...binding.sessionConfig, [configId]: value } }))
      await this.adapter.activity?.updateConfiguration(dshSessionId, route, session.configOptions)
      return { configOptions: session.configOptions }
    } finally { await session.close() }
  }

  async inspect({ dshSessionId, runId, route }) {
    this.profile(route)
    return this.withIdle(dshSessionId, route, async () => {
      await this.adapter.activity.load()
      const run = this.adapter.activity.scopedRun(dshSessionId, runId)
      if (run.route !== route) throw new SessionAdminError('execution route mismatch', 'NOT_FOUND')
      return this.adapter.activity.review(dshSessionId, runId)
    })
  }

  async acknowledge({ dshSessionId, runId, route }) {
    this.profile(route)
    return this.withIdle(dshSessionId, route, async () => {
      await this.adapter.activity.load()
      const run = this.adapter.activity.scopedRun(dshSessionId, runId)
      if (run.route !== route) throw new SessionAdminError('execution route mismatch', 'NOT_FOUND')
      return this.adapter.activity.acknowledge(dshSessionId, runId)
    })
  }

  async connection({ dshSessionId, route }) {
    const profile = this.profile(route)
    return this.withIdle(dshSessionId, route, async () => {
      const transport = await this.transport(profile, profile.cwd ?? this.resolveCwd(dshSessionId))
      // Initialize only: no load/new/catalog/prompt, no inference or session rebinding.
      return { connected: !transport.closed, route, transport: transport.kind, checkedAt: Date.now(),
        verified: transport.kind === 'acp' ? 'protocol-handshake' : 'recipe-only', capabilities: [...transport.capabilities] }
    })
  }

  async retryPersistence(dshSessionId) {
    if (this.adapter.runControllers?.size) throw new SessionAdminError('stop active work before retrying saved state', 'BUSY')
    const runs = await this.adapter.activity?.list(dshSessionId) ?? []
    if (runs.some(run => ['queued', 'starting', 'running', 'waiting', 'finalizing', 'cancelling'].includes(run.status))) throw new SessionAdminError('stop active work before retrying saved state', 'BUSY')
    const activity = await this.adapter.activity?.saveWithoutExecution() ?? { saved: true }
    let bindings
    await this.registry.load()
    try { await this.registry.flush(); this.registry.persistenceError = undefined; bindings = { saved: true } }
    catch (error) { bindings = { saved: false, error: error.message, code: error.code ?? 'STATE_SAVE' } }
    if (activity.saved && bindings.saved) for (const run of this.adapter.activity?.runs.values() ?? []) if (run.dshSessionId === dshSessionId) delete run.bindingPersistenceError
    return { activity, bindings, saved: activity.saved && bindings.saved, reexecuted: false }
  }

  async diagnosticReport(dshSessionId) {
    const report = await this.adapter.activity?.diagnostics(dshSessionId) ?? { version: 1, runs: [] }
    report.bindings = { readOnly: Boolean(this.registry.readOnly), error: this.registry.persistenceError }
    return report
  }

  /** Passive, current bindings only. Never constructs a session for UI polling. */
  async configuration(dshSessionId) {
    return (await this.registry.all()).filter(row => row.dshSessionId === dshSessionId && this.current().profiles.has(row.route)).map(row => ({
      route: row.route, displayName: this.profile(row.route).displayName,
      options: row.binding.configOptions ?? [], configurable: (row.binding.capabilities ?? []).includes(CAPABILITY.CONFIGURE)
        && (row.binding.capabilities ?? []).includes(CAPABILITY.RESUME) && !this.adapter.isBusy?.(dshSessionId, row.route),
    }))
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
