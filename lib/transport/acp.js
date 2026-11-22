/**
 * Agent Client Protocol transport.
 *
 * One process serves every session of one (route, cwd) pair: ACP addresses
 * sessions by id, so a single child can host several DSH conversations and a
 * warm process is shared instead of spawned per turn.
 *
 * The wire work is the official SDK's; this module owns process lifetime,
 * session registration, update routing, permission policy, and the mapping
 * onto {@link module:dsh-agent-providers/transport/contract} events.
 *
 * Proven patterns are lifted from the harness's own ACP client
 * (`@deepseek-ai/dsh-subagent-acp`): `session/cancel` is a notification, a
 * permission request is answered by policy from the offered options, and
 * startup failures are reported with the child's stderr tail.
 *
 * @module dsh-agent-providers/transport/acp
 */
import { spawn } from 'node:child_process'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'
import { scrubbedParentEnv } from '../env.js'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import {
  CAPABILITY,
  STOP_REASON,
  assertSession,
  assertTransport,
} from './contract.js'

/** A failure of the child process or of the protocol itself. */
export class AcpFailure extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'AcpFailure'
  }
}

/** Race a promise against a relative timeout. */
function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AcpFailure(message)), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** ACP prompt blocks for one turn, dropping what the agent cannot read. */
function promptBlocks(text, images, acceptsImages) {
  const blocks = []
  if (text.trim().length > 0) blocks.push({ type: 'text', text })
  if (acceptsImages && images !== undefined) {
    for (const image of images) {
      blocks.push({
        type: 'image',
        data: Buffer.from(image.data).toString('base64'),
        mimeType: image.mediaType,
      })
    }
  } else if (!acceptsImages && images !== undefined && images.length > 0) {
    blocks.push({
      type: 'text',
      text: `[${images.length} image(s) attached; this agent does not accept image input]`,
    })
  }
  return blocks
}

/** Map an ACP stop reason onto the contract's vocabulary. */
function stopReasonOf(value) {
  switch (value) {
    case 'end_turn': return STOP_REASON.END_TURN
    case 'max_tokens': return STOP_REASON.MAX_TOKENS
    case 'cancelled': return STOP_REASON.CANCELLED
    case 'refusal': return STOP_REASON.REFUSAL
    case 'max_turn_requests': return STOP_REASON.TURN_LIMIT
    default: return STOP_REASON.UNKNOWN
  }
}

/** Translate one `session/update` into at most one contract event. */
function translate(update) {
  if (update === null || typeof update !== 'object') return undefined
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content?.type === 'text' ? { type: 'text', text: update.content.text } : undefined
    case 'agent_thought_chunk':
      return update.content?.type === 'text' ? { type: 'reasoning', text: update.content.text } : undefined
    case 'tool_call':
      return { type: 'tool', title: String(update.title ?? update.name ?? update.kind ?? 'tool'), status: 'started' }
    case 'tool_call_update':
      if (update.status === 'failed') {
        return { type: 'tool', title: String(update.title ?? update.toolCallId), status: 'failed' }
      }
      if (update.status === 'completed') {
        return { type: 'tool', title: String(update.title ?? update.toolCallId), status: 'completed' }
      }
      return undefined
    case 'plan':
      return Array.isArray(update.entries) && update.entries.length > 0
        ? { type: 'plan', text: update.entries.map((entry) => String(entry?.content ?? '')).filter(Boolean).join('\n') }
        : undefined
    case 'usage_update':
      // `{used, size}` is the agent's own account of the conversation and the
      // model's window. Not every agent sends it; when one does, the harness
      // learns a truer context window than any default could guess.
      return typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0
        ? {
            type: 'context',
            used: typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : 0,
            size: update.size,
          }
        : undefined
    case 'session_info_update':
      return typeof update.title === 'string' ? { type: 'title', title: update.title } : undefined
    case 'config_option_update':
      return undefined
    default:
      return undefined
  }
}

/** One conversation on a shared ACP process. */
class AcpSession {
  /**
   * @param {AcpTransport} transport
   * @param {string} externalId
   * @param {{ resumed: boolean, configOptions?: readonly any[] }} facts
   */
  constructor(transport, externalId, facts) {
    this.transport = transport
    this.externalId = externalId
    this.resumed = facts.resumed
    this.capabilities = transport.capabilities
    this.configOptions = facts.configOptions ?? []
    /** Legacy `modes` block, still published by some agents beside config options. */
    this.modes = facts.modes
    /** @type {((update: any) => void) | undefined} */
    this.sink = undefined
    this.busy = false
    this.cancelled = false
  }

  /** The agent's model selector among this session's config options. */
  get modelOption() {
    const options = Array.isArray(this.configOptions) ? this.configOptions : []
    const selects = options.filter((option) => option?.type === 'select')
    return selects.find((option) => option.category === 'model') ?? selects[0]
  }

  /**
   * Switch the model of this session.
   *
   * ACP exposes the choice as a `select` config option rather than a dedicated
   * method, so an agent without one simply keeps its own default: a no-op keeps
   * the turn usable instead of failing it over a presentation detail.
   * @param {string} modelId
   */
  async selectModel(modelId) {
    const option = this.modelOption
    if (option === undefined) return
    const configId = option.id ?? option.configId
    if (typeof configId !== 'string') {
      throw new AcpFailure(`agent "${this.transport.profile.route}" published a model option without an id`)
    }
    if (option.currentValue === modelId) return
    this.configOptions = await this.transport.guard(
      this.transport.agent.request(methods.agent.session.setConfigOption, {
        sessionId: this.externalId,
        configId,
        value: modelId,
      }),
      'session/set_config_option',
    ).then((response) => response?.configOptions ?? this.configOptions)
  }

  /**
   * Apply the profile's session configuration: `configOptions` by id, and the
   * legacy `mode` when the agent publishes modes instead of a config option.
   *
   * Options differ per agent, so an unknown id is reported and skipped rather
   * than failing the session: the profile may be shared across agents.
   */
  async applyConfig() {
    const wanted = this.transport.profile.configOptions ?? {}
    for (const [id, value] of Object.entries(wanted)) {
      const option = (this.configOptions ?? []).find((entry) => entry?.id === id || entry?.category === id)
      if (option !== undefined) {
        const configId = option.id ?? option.configId
        if (option.currentValue === value) continue
        this.configOptions = await this.transport.guard(
          this.transport.agent.request(methods.agent.session.setConfigOption, {
            sessionId: this.externalId,
            configId,
            value,
          }),
          `session/set_config_option (${id})`,
        ).then((response) => response?.configOptions ?? this.configOptions)
        continue
      }
      if (id === 'mode' && this.modes !== undefined) {
        await this.setMode(value)
        continue
      }
      this.transport.logger?.error?.(
        `dsh-agent-providers: agent "${this.transport.profile.route}" has no session option "${id}"; skipping`,
      )
    }
  }

  /** Select a session mode through the legacy `session/set_mode` method. */
  async setMode(modeId) {
    if (this.modes?.currentModeId === modeId) return
    const response = await this.transport.guard(
      this.transport.agent.request(methods.agent.session.setMode, { sessionId: this.externalId, modeId }),
      'session/set_mode',
    )
    if (response?.modes !== undefined) this.modes = response.modes
  }

  /**
   * @param {any} request
   */
  async prompt(request) {
    if (this.busy) {
      throw new AcpFailure(`agent "${this.transport.profile.route}" is already running a prompt in this session`)
    }
    if (this.transport.closed) {
      throw new AcpFailure(`agent "${this.transport.profile.route}" has exited`)
    }
    this.busy = true
    this.cancelled = false
    this.sink = (update) => {
      this.transport.touch()
      const event = translate(update)
      if (event !== undefined) request.onUpdate?.(event)
    }

    const onAbort = () => {
      this.cancelled = true
      // `session/cancel` is a notification, not a request.
      void this.transport.agent.notify(methods.agent.session.cancel, { sessionId: this.externalId })
    }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    this.transport.armIdleTimer(false)
    try {
      const response = await this.transport.guard(
        this.transport.agent.request(methods.agent.session.prompt, {
          sessionId: this.externalId,
          prompt: promptBlocks(request.text, request.images, this.capabilities.has(CAPABILITY.IMAGES)),
        }),
        'session/prompt',
      )
      return {
        stopReason: stopReasonOf(response?.stopReason),
        usage: mapUsage(response?.usage),
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      this.sink = undefined
      this.busy = false
      this.transport.armIdleTimer(true)
    }
  }

  /**
   * Release this handle without destroying the conversation.
   *
   * The agent keeps the session in its own store, which is exactly what a later
   * `resume` needs. Callers that created a throwaway session must use
   * {@link discard} instead.
   */
  async close() {
    this.transport.forgetSession(this.externalId)
  }

  /** Drop the conversation in the agent's own store, then release the handle. */
  async discard() {
    if (!this.transport.closed) {
      // Best effort: a stray session is harmless but noise.
      await this.transport.agent
        .request(methods.agent.session.close, { sessionId: this.externalId })
        .catch(() => {})
    }
    this.transport.forgetSession(this.externalId)
  }
}

/**
 * Deeply replace `{value}` in every string of a template.
 *
 * The same vocabulary `credentials` uses for child variables, so one profile
 * language describes both places a secret has to reach.
 */
function fillTemplate(value, secret) {
  if (typeof value === 'string') {
    return secret === undefined ? value : value.split('{value}').join(String(secret))
  }
  if (Array.isArray(value)) return value.map((entry) => fillTemplate(entry, secret))
  if (value !== null && typeof value === 'object') {
    const filled = {}
    for (const [key, entry] of Object.entries(value)) filled[key] = fillTemplate(entry, secret)
    return filled
  }
  return value
}

/**
 * ACP usage → harness-disjoint token counts.
 *
 * Measured against OpenCode: `inputTokens` is the **uncached** prompt count and
 * the cached portion arrives separately (one turn reported input 127 with
 * cacheRead 7680), so the harness's "inputTokens is uncached only" rule already
 * holds and subtracting would corrupt it. `totalTokens` is not a consistent
 * "this call" total across agents, so it is left for the harness to derive.
 */
function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const mapped = { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens) }
  if (count(usage.cachedReadTokens) > 0) mapped.cacheReadTokens = count(usage.cachedReadTokens)
  if (count(usage.cachedWriteTokens) > 0) mapped.cacheWriteTokens = count(usage.cachedWriteTokens)
  if (count(usage.thoughtTokens) > 0) mapped.reasoningTokens = count(usage.thoughtTokens)
  return mapped
}

export class AcpTransport {
  /**
   * @param {object} profile - a resolved agent profile.
   * @param {string} cwd - the working directory this transport serves.
   * @param {{ logger?: any }} [options]
   */
  constructor(profile, cwd, options = {}) {
    this.kind = 'acp'
    this.profile = profile
    this.cwd = cwd
    this.logger = options.logger
    /** Credential reader, for an agent that requires `authenticate`. */
    this.credentials = options.credentials
    this.child = undefined
    this.connection = undefined
    this.agent = undefined
    this.stderrTail = ''
    this.spawnError = undefined
    this.closed = false
    /** Auth method ids the agent advertised, empty when it needs none. */
    this.authMethods = []
    /** Sessions currently registered for update routing. */
    this.sessions = new Map()
    this.capabilities = new Set([CAPABILITY.RESUME, CAPABILITY.LIST, CAPABILITY.FORK, CAPABILITY.SWITCH_MODEL, CAPABILITY.IMAGES, CAPABILITY.STREAM])
    this.idleTimer = undefined
    this.lastUsedAt = Date.now()
    /** The command actually spawned, after executable resolution. */
    this.executable = profile.executable ?? profile.command
  }

  /** Spawn the agent, negotiate the protocol, and learn its capabilities. */
  async start() {
    const command = this.profile.executable ?? this.profile.command
    const { args, env } = this.profile
    const child = spawn(command, args, {
      cwd: this.cwd,
      // Never hand the agent the harness's whole environment: the base is
      // scrubbed, and only what the profile maps is forwarded.
      env: { ...scrubbedParentEnv(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.on('error', (error) => { this.spawnError = error })
    child.on('exit', () => { this.closed = true })
    child.stdin.on('error', () => {})
    child.stderr.setEncoding?.('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-8_000)
    })

    const app = createAcpClientApp({ name: 'dsh-agent-providers' })
      .onNotification(methods.client.session.update, ({ params }) => {
        const session = this.sessions.get(params?.sessionId)
        session?.sink?.(params.update)
        return Promise.resolve()
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        return Promise.resolve(this.answerPermission(params))
      })

    this.connection = app.connect(ndJsonStream(
      NodeWritable.toWeb(child.stdin),
      NodeReadable.toWeb(child.stdout),
    ))
    this.agent = this.connection.agent

    // `guard` owns the failure mapping, so a child that dies during startup is
    // reported with its command, exit and stderr instead of a bare EPIPE.
    const initialized = await this.guard(
      this.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        // The agent self-serves files and terminals in its own process.
        clientCapabilities: {},
      }),
      'initialize',
    )

    const advertised = initialized?.agentCapabilities ?? {}
    const session = advertised.sessionCapabilities ?? {}
    this.capabilities = new Set([CAPABILITY.STREAM])
    if (advertised.loadSession === true) this.capabilities.add(CAPABILITY.RESUME)
    if (session.list !== undefined && session.list !== null) this.capabilities.add(CAPABILITY.LIST)
    if (session.fork !== undefined && session.fork !== null) this.capabilities.add(CAPABILITY.FORK)
    if (session.delete !== undefined && session.delete !== null) this.capabilities.add(CAPABILITY.DELETE)
    // ACP has no "set model" method; the choice is a session config option, so
    // the capability is real whenever a session publishes a model selector.
    // A session without one makes `selectModel()` a no-op rather than an error.
    this.capabilities.add(CAPABILITY.SWITCH_MODEL)
    if (advertised.promptCapabilities?.image === true) this.capabilities.add(CAPABILITY.IMAGES)

    // Some agents refuse `session/new` until `authenticate` succeeds, and they
    // advertise the methods they accept. An agent that asks for none is left
    // alone: OpenCode reads its credential document and would reject a call.
    this.authMethods = (initialized?.authMethods ?? [])
      .map((method) => (typeof method === 'string' ? method : method?.id))
      .filter((id) => typeof id === 'string' && id.length > 0)
    if (this.authMethods.length > 0 && typeof this.profile.auth?.methodId === 'string') {
      await this.authenticate(this.profile.auth)
    }

    this.armIdleTimer(true)
    return assertTransport(this)
  }

  /**
   * Tell the agent who we are, using the parameters the profile supplies.
   *
   * ACP leaves the shape of an authentication request to the agent, so the
   * profile writes it verbatim (`params`) and the plugin only fills `{value}`
   * with the resolved credential — the same template vocabulary the child
   * environment already uses.
   */
  async authenticate(auth) {
    const value = auth.ref === undefined
      ? undefined
      : await this.credentials?.resolve(auth.ref)
    if (auth.ref !== undefined && (value === undefined || value === null)) {
      throw new AcpFailure(
        `agent "${this.profile.route}" needs credential "${auth.ref}" to sign in, but none is stored`,
      )
    }
    const params = {
      methodId: auth.methodId,
      ...fillTemplate(auth.params ?? {}, value),
    }
    await this.guard(this.agent.request(methods.agent.authenticate, params), `authenticate (${auth.methodId})`)
  }

  /** Answer one permission request without a human. */
  answerPermission(params) {
    const session = this.sessions.get(params?.sessionId)
    const policy = this.profile.permission
    if (policy === 'allow') {
      const allow = (params?.options ?? []).find(
        (option) => option?.kind === 'allow_once' || option?.kind === 'allow_always',
      )
      if (allow !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    void session
    return { outcome: { outcome: 'cancelled' } }
  }

  /** Read the model catalogue through one short-lived session. */
  async catalog() {
    const session = await this.create()
    try {
      const option = session.modelOption
      const values = option?.options
      const flat = []
      for (const entry of Array.isArray(values) ? values : []) {
        if (entry !== null && typeof entry === 'object' && Array.isArray(entry.options)) {
          flat.push(...entry.options)
        } else if (entry !== null && typeof entry === 'object') {
          flat.push(entry)
        }
      }
      return flat
        .filter((entry) => typeof entry.value === 'string')
        .map((entry) => ({
          id: entry.value,
          name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.value,
          ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        }))
    } finally {
      await session.discard()
    }
  }

  async create() {
    const response = await this.guard(
      this.agent.request(methods.agent.session.new, { cwd: this.cwd, mcpServers: [] }),
      'session/new',
    )
    const externalId = response?.sessionId
    if (typeof externalId !== 'string' || externalId.length === 0) {
      throw new AcpFailure(`agent "${this.profile.route}" answered session/new without a session id`)
    }
    const session = new AcpSession(this, externalId, {
      resumed: false,
      configOptions: response.configOptions ?? [],
      modes: response.modes,
    })
    this.sessions.set(externalId, session)
    await session.applyConfig()
    this.touch()
    return assertSession(session, this.kind)
  }

  async resume(externalId) {
    const response = await this.guard(
      this.agent.request(methods.agent.session.load, { sessionId: externalId, cwd: this.cwd, mcpServers: [] }),
      'session/load',
    )
    const session = new AcpSession(this, externalId, {
      resumed: true,
      configOptions: response?.configOptions ?? [],
      modes: response?.modes,
    })
    this.sessions.set(externalId, session)
    this.touch()
    return assertSession(session, this.kind)
  }

  /**
   * Branch a stored session without touching the original.
   * @returns the new external session id.
   */
  async fork(externalId) {
    if (!this.capabilities.has(CAPABILITY.FORK)) {
      throw new AcpFailure(`agent "${this.profile.route}" cannot fork sessions`)
    }
    const response = await this.guard(
      this.agent.request(methods.agent.session.fork, { sessionId: externalId, cwd: this.cwd, mcpServers: [] }),
      'session/fork',
    )
    const forked = response?.sessionId
    if (typeof forked !== 'string' || forked.length === 0) {
      throw new AcpFailure(`agent "${this.profile.route}" answered session/fork without a session id`)
    }
    this.touch()
    return forked
  }

  /** Release the agent's resources for one session; its history survives. */
  async closeSession(externalId) {
    this.sessions.delete(externalId)
    if (this.closed) return
    await this.agent.request(methods.agent.session.close, { sessionId: externalId }).catch(() => {})
    this.armIdleTimer(true)
  }

  /** Permanently remove a stored session. */
  async deleteSession(externalId) {
    if (!this.capabilities.has(CAPABILITY.DELETE)) {
      throw new AcpFailure(`agent "${this.profile.route}" cannot delete sessions`)
    }
    this.sessions.delete(externalId)
    await this.guard(
      this.agent.request(methods.agent.session.delete, { sessionId: externalId }),
      'session/delete',
    )
    this.armIdleTimer(true)
  }

  async list() {
    if (!this.capabilities.has(CAPABILITY.LIST)) return []
    const response = await this.guard(
      this.agent.request(methods.agent.session.list, { cwd: this.cwd }),
      'session/list',
    )
    const sessions = Array.isArray(response?.sessions) ? response.sessions : []
    return sessions.map((entry) => ({
      sessionId: String(entry.sessionId),
      cwd: typeof entry.cwd === 'string' ? entry.cwd : this.cwd,
      title: typeof entry.title === 'string' ? entry.title : undefined,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : undefined,
    }))
  }

  async close() {
    clearTimeout(this.idleTimer)
    if (this.closed) return
    this.closed = true
    this.sessions.clear()
    try {
      this.child?.stdin.end()
    } catch {
      // The child may already have closed its stdin.
    }
    try {
      this.child?.kill('SIGTERM')
    } catch {
      // An already-reaped child needs no signal.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { this.child?.kill('SIGKILL') } catch { /* already gone */ }
        resolve()
      }, 3_000)
      timer.unref?.()
      this.child?.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Forget one session locally without touching the shared process. */
  forgetSession(externalId) {
    this.sessions.delete(externalId)
    this.armIdleTimer(true)
  }

  /** Mark activity so the idle release does not reap a busy process. */
  touch() {
    this.lastUsedAt = Date.now()
    this.armIdleTimer(true)
  }

  /** Arm or disarm this transport's idle release. */
  armIdleTimer(armed) {
    clearTimeout(this.idleTimer)
    if (!armed || this.closed) return
    const busy = () => [...this.sessions.values()].some((session) => session.busy)
    if (busy()) return
    this.idleTimer = setTimeout(() => {
      if (busy()) {
        this.armIdleTimer(true)
        return
      }
      this.logger?.error?.(`dsh-agent-providers: releasing idle agent "${this.profile.route}"`)
      void this.close()
    }, this.profile.idleReleaseMs)
    this.idleTimer.unref?.()
  }

  /** Detached facts about this launch, safe to log (no environment values). */
  diagnostics() {
    return {
      kind: this.kind,
      route: this.profile.route,
      executable: this.executable,
      args: [...this.profile.args],
      cwd: this.cwd,
      envKeys: Object.keys(this.profile.env ?? {}).sort(),
      exitCode: this.child?.exitCode ?? null,
      stderrTail: this.stderrTail.trim().split('\n').slice(-6).join(' / ').slice(0, 600),
    }
  }

  /** Last few stderr lines, for a failure the model can act on. */
  stderrHint() {
    const tail = this.stderrTail.trim()
    if (tail.length === 0) return ''
    return ` (stderr: ${tail.split('\n').slice(-3).join(' / ')})`
  }

  /** Await an ACP request, mapping transport trouble to {@link AcpFailure}. */
  async guard(promise, stage) {
    try {
      return await withTimeout(
        promise,
        this.profile.connectTimeoutMs,
        `agent "${this.profile.route}" did not answer ${stage} within ${this.profile.connectTimeoutMs}ms`,
      )
    } catch (error) {
      if (error instanceof AcpFailure) throw error
      if (this.spawnError !== undefined) {
        throw new AcpFailure(`cannot start "${this.profile.command}": ${this.spawnError.message}`, { cause: error })
      }
      // A child that dies before answering leaves only EPIPE behind; report the
      // command and its exit instead of a stream error nobody can act on.
      if (this.child !== undefined && this.child.exitCode !== null) {
        throw new AcpFailure(
          `"${this.profile.command}" exited with code ${this.child.exitCode} before answering ${stage}${this.stderrHint()}`,
          { cause: error },
        )
      }
      const detail = typeof error?.message === 'string' && error.message.length > 0 ? `: ${error.message}` : ''
      throw new AcpFailure(
        `agent "${this.profile.route}" failed during ${stage}${detail}${this.stderrHint()}`,
        { cause: error },
      )
    }
  }
}
