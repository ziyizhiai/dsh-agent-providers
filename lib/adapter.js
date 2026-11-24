/**
 * The `LlmAdapter` that makes external coding agents look like model providers.
 *
 * The harness sends a full request and expects raw chunks back. This adapter
 * maps a DSH Session onto an external agent conversation, forwards the new
 * user input, and translates the transport's normalized events into the
 * harness `StreamChunk` protocol.
 *
 * It knows nothing about protocols: every ACP or CLI detail lives behind
 * {@link module:dsh-agent-providers/transport/contract}. What it does own:
 *
 * - **Binding** — one DSH Session to one external conversation, persisted and
 *   re-validated, never assumed.
 * - **Resume or replay** — resume only when the binding provably still matches
 *   the request; otherwise replay the transcript and rebind.
 * - **Chunk assembly** — exactly one assistant message per step, with no tool
 *   calls (the agent owns its tools) and tool activity folded into reasoning.
 * - **Serialization** — one prompt at a time per (Session, route).
 *
 * @module dsh-agent-providers/adapter
 */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { SessionBinding } from './registry.js'
import {
  CAPABILITY,
  STOP_REASON,
  supports,
} from './transport/contract.js'
import { createTransport, resolveEnv } from './transport/index.js'
import { profileGeneration } from './config.js'
import { safeError, safeLogger, redactValue, redactText } from './redact.js'
import { Semaphore, raceAbort, throwIfAborted, abortError } from './lifecycle.js'
import {
  continuityDecision,
  conversationWitness,
  humanUserTexts,
  renderDelta,
  renderTranscript,
  userHistoryDigest,
} from './render.js'

const DEFAULT_CONTEXT_WINDOW = 200_000
const CATALOG_CACHE_MS = 10 * 60_000
const CATALOG_FAILURE_CACHE_MS = 60_000
/** Upper bound on images forwarded in one turn. */
const MAX_PROMPT_IMAGES = 8

/** A one-consumer queue that lets a callback stream into an async generator. */
class Channel {
  constructor() {
    this.items = []
    this.waiters = []
    this.closed = false
  }

  push(item) {
    if (this.closed) return
    const last = this.items.at(-1)
    if (last && last.type === item.type && last.index === item.index && typeof item.text === 'string'
      && last.text.length + item.text.length <= 65536) { last.text += item.text; return }
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter({ value: item })
    else {
      if (this.items.length >= 4096) { const error = new Error('stream consumer is too slow'); error.code = 'STREAM_BACKPRESSURE'; throw error }
      this.items.push(item)
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true })
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()
        continue
      }
      if (this.closed) return
      const next = await new Promise((resolve) => { this.waiters.push(resolve) })
      if (next.done === true) return
      yield next.value
    }
  }
}

/** The selector badge for one route. */
function badgeOf(profile) {
  return { text: profile.badgeText, tone: profile.badgeTone }
}

/** Badge for a model the agent reported as not accessible on this plan. */
const DENIED_BADGE = { text: { en: 'no access', zh: '无权限' }, tone: 'warning' }

/** Does this failure mean "your plan does not include that model"? */
function isAccessDenial(message) {
  return typeof message === 'string'
    && /access is disabled|not enabled|no access|forbidden|unauthori[sz]ed|permission/i.test(message)
}

/**
 * A session title derived from the request itself.
 *
 * The harness asks a model for a title on the first prompt. Spending an external
 * agent run on that is absurd, and refusing loses the title entirely, so derive
 * it from the user's own words instead.
 */
function localTitle(options) {
  const texts = humanUserTexts(options)
  const source = texts.at(-1) ?? ''
  const firstLine = source.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  if (firstLine.length === 0) return ''
  const chars = Array.from(firstLine)
  return chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : firstLine
}

/** Contract stop reason → harness finish reason. Unknown values are failures. */
/**
 * The four ways a refusal to answer arrives, so "the agent stopped" is never
 * reported for a turn the *user* stopped by rejecting an approval.
 */
const APPROVAL_FAILURES = {
  rejected: { message: 'you rejected the approval request', code: 'APPROVAL_REJECTED' },
  dismissed: { message: 'you dismissed the approval request', code: 'APPROVAL_DISMISSED' },
  unavailable: { message: 'no approval channel answered', code: 'APPROVAL_UNAVAILABLE' },
  policy: { message: 'this route denies the agent its tools (permission: reject)', code: 'APPROVAL_DENIED' },
}

/**
 * @param {string} stopReason
 * @param {{ approvalDenied?: string }} [outcome]
 */
function finishFor(stopReason, outcome) {
  switch (stopReason) {
    case STOP_REASON.END_TURN:
      return { kind: 'stop' }
    case STOP_REASON.MAX_TOKENS:
      return { kind: 'max-tokens' }
    case STOP_REASON.CANCELLED: {
      const denial = APPROVAL_FAILURES[outcome?.approvalDenied]
      if (denial === undefined) {
        return { kind: 'aborted', failure: { message: 'the external agent cancelled the turn', code: 'ABORTED' } }
      }
      // Name the tool: "no approval channel answered" alone leaves the user
      // guessing what the agent wanted to do.
      const what = outcome?.approvalDeniedTool === undefined ? 'a tool call' : outcome.approvalDeniedTool
      return {
        kind: 'aborted',
        failure: { message: `${denial.message} for ${what}, so the agent stopped this turn`, code: denial.code },
      }
    }
    case STOP_REASON.REFUSAL:
      return { kind: 'error', failure: { message: 'the external agent refused the request', code: 'REFUSAL' } }
    case STOP_REASON.TURN_LIMIT:
      return { kind: 'error', failure: { message: 'the external agent hit its internal turn limit before finishing', code: 'MAX_TURN_REQUESTS' } }
    default:
      return { kind: 'error', failure: { message: `the external agent stopped for an unknown reason: ${String(stopReason)}`, code: 'PROVIDER' } }
  }
}

/** One assistant message being assembled from normalized transport events. */
class ChunkWriter {
  constructor(showToolActivity) {
    this.showToolActivity = showToolActivity
    this.nextIndex = 0
    this.text = undefined
    this.reasoning = undefined
    this.notes = new Set()
    this.pending = []
    this.toolStates = new Map()
    this.closed = false
    this.contentChars = 0
  }

  drain() {
    const chunks = this.pending
    this.pending = []
    return chunks
  }

  openText() {
    if (this.text !== undefined) return this.text
    const index = this.nextIndex
    this.nextIndex += 1
    this.text = { index, text: '' }
    this.pending.push({ type: 'block-start', index, blockType: 'text' })
    return this.text
  }

  openReasoning() {
    if (this.reasoning !== undefined) return this.reasoning
    const index = this.nextIndex
    this.nextIndex += 1
    this.reasoning = { index, text: '' }
    this.pending.push({ type: 'block-start', index, blockType: 'reasoning' })
    return this.reasoning
  }

  pushText(text) {
    if (text.length === 0) return
    this.contentChars += text.length
    if (this.contentChars > 4 * 1024 * 1024) { const error = new Error('assistant content exceeds stream bound'); error.code = 'STREAM_LIMIT'; throw error }
    const block = this.openText()
    block.text += text
    this.pending.push({ type: 'text-delta', index: block.index, text })
  }

  pushThought(text) {
    if (text.length === 0) return
    this.contentChars += text.length
    if (this.contentChars > 4 * 1024 * 1024) { const error = new Error('assistant content exceeds stream bound'); error.code = 'STREAM_LIMIT'; throw error }
    const block = this.openReasoning()
    block.text += text
    this.pending.push({ type: 'reasoning-delta', index: block.index, text })
  }

  /** Fold one breadcrumb into the reasoning channel, at most once. */
  pushNote(line) {
    if (!this.showToolActivity) return
    const normalized = line.trim()
    if (normalized.length === 0 || this.notes.has(normalized)) return
    this.notes.add(normalized)
    this.pushThought(`\n${normalized}`)
  }

  /** Close every open block in ascending index order. */
  close() {
    if (this.closed) return []
    this.closed = true
    const open = [this.reasoning, this.text]
      .filter((block) => block !== undefined)
      .sort((left, right) => left.index - right.index)
    for (const block of open) {
      const type = block === this.reasoning ? 'reasoning' : 'text'
      this.pending.push({ type: 'block-end', index: block.index, block: { type, text: block.text } })
    }
    return this.drain()
  }

  /** Map one contract event into this message. */
  accept(event) {
    switch (event.type) {
      case 'text':
        this.pushText(event.text)
        return
      case 'reasoning':
        this.pushThought(event.text)
        return
      case 'tool': {
        if (!this.showToolActivity) return
        const key = event.id ?? event.title
        if (this.toolStates.get(key) === event.status) return
        this.toolStates.set(key, event.status)
        const symbol = event.status === 'failed' ? '✗' : event.status === 'completed' ? '✓' : '→'
        this.pushThought(`\n${symbol} ${event.title}`)
        return
      }
      case 'plan':
        for (const entry of event.entries ?? []) this.pushNote(`${entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '→' : '◻'} ${entry.content}`)
        if (!event.entries) for (const line of String(event.text ?? '').split('\n')) if (line.trim()) this.pushNote(`◻ ${line.trim()}`)
        return
      default:
        // `title`, `model` and `raw` carry no assistant content.
        return
    }
  }
}

export class AgentProviderAdapter extends LlmAdapter {
  /**
   * @param {object} dependencies
   * @param {() => { profiles: Map<string, any>, maxReplayChars: number }} dependencies.current
   * @param {import('./registry.js').SessionRegistry} dependencies.registry
   * @param {(sessionId?: string) => string} dependencies.resolveCwd
   * @param {{ resolve: (ref: string) => Promise<{ value: string } | undefined> }} dependencies.credentials
   * @param {(request: { sessionId?: string, toolName: string, reason?: string, displayReason?: Record<string, string>, signal?: AbortSignal }) => Promise<string>} [dependencies.askApproval]
   * @param {{ error?: (...args: any[]) => void }} [dependencies.logger]
   */
  constructor({
    current, registry, resolveCwd, credentials, logger, resolveExecutable, diagnostics, readImage, canReadImage, askApproval, activity,
  }) {
    super()
    this.current = current
    this.registry = registry
    this.resolveCwd = resolveCwd
    this.credentials = credentials
    this.resolveExecutable = resolveExecutable
    this.diagnostics = diagnostics
    /** `(ref, signal) => Promise<{ data: Uint8Array }>` from the attachment service. */
    this.readImage = readImage
    this.canReadImage = canReadImage ?? (() => typeof readImage === 'function')
    /**
     * `(request) => Promise<ApprovalOutcome>` from the harness approval service.
     * Absent in a composition that has none, which makes `permission: 'ask'`
     * fail closed rather than silently allow.
     */
    this.askApproval = askApproval
    this.logger = safeLogger(logger)
    /** @type {Map<string, { transport: any, promise: Promise<any> }>} */
    this.transports = new Map()
    /** @type {Map<string, { at: number, models: any[] }>} */
    this.catalogs = new Map()
    /**
     * Context windows an agent reported for itself, keyed by route + model.
     * Learnt from `usage_update`, so the meter and compaction correct along with
     * the agent instead of trusting the profile forever.
     * @type {Map<string, number>}
     */
    this.learnedContext = new Map()
    /**
     * Context windows the agent published in its own catalogue (`_meta`),
     * keyed by route + model. Read once per catalogue fetch, so a probed route
     * is metered right from the first turn instead of at the route default.
     * @type {Map<string, number>}
     */
    this.reportedContext = new Map()
    /**
     * In-flight catalogue probes, so a metering lookup and a picker lookup at
     * the same moment do not each spawn a session.
     * @type {Map<string, Promise<void>>}
     */
    this.catalogProbes = new Map()
    /**
     * Models an agent refused for access reasons, keyed by route. They stay
     * advertised — the catalogue is the agent's, not ours — but carry a warning
     * badge so the picker says why they will not answer.
     * @type {Map<string, Set<string>>}
     */
    this.denied = new Map()
    /** @type {Map<string, Promise<void>>} */
    this.locks = new Map()
    this.activity = activity
    this.admissions = new Map()
    this.activeRuns = new Map()
    this.profileFingerprints = new Map()
    this.catalogInflight = new Map()
    this.disposed = false
    this.queuedControllers = new Set()
    this.runControllers = new Map()
  }

  /** @param {string} route */
  providerInfo(route) {
    const profile = this.current().profiles.get(route)
    return { id: route, name: profile?.displayName ?? route }
  }

  /**
   * Advertise the models this agent offers.
   *
   * An explicit `models:` list wins. Otherwise the transport's own catalogue is
   * read once per route and cached; a failure leaves the group visible but
   * empty until it is retried.
   *
   * @param {string} route
   */
  async listModels(route) {
    const inflight = this.catalogInflight.get(route)
    if (inflight) return inflight
    const promise = this.listModelsOnce(route).finally(() => {
      if (this.catalogInflight.get(route) === promise) this.catalogInflight.delete(route)
    })
    this.catalogInflight.set(route, promise)
    return promise
  }

  async listModelsOnce(route) {
    const profile = this.current().profiles.get(route)
    if (profile === undefined) return []
    // `auto` keeps the historical reading: a declared list is the catalogue.
    // `probe` asks the agent anyway and treats declared entries as overrides,
    // which is how a window can be pinned per model without re-declaring the
    // agent's whole catalogue.
    const mode = profile.catalog ?? 'auto'
    if (mode === 'declared' || (mode === 'auto' && profile.models.length > 0)) {
      return this.declaredModels(profile)
    }

    const cached = this.catalogs.get(route)
    const ttl = cached !== undefined && cached.models.length > 0 ? CATALOG_CACHE_MS : CATALOG_FAILURE_CACHE_MS
    if (cached !== undefined && Date.now() - cached.at < ttl) return cached.models

    let models = []
    try {
      const transport = await this.transportFor(profile, profile.cwd ?? this.resolveCwd(undefined))
      const catalog = await transport.catalog({ cwd: profile.cwd ?? this.resolveCwd(undefined) })
      const overrides = new Map(profile.models.map((model) => [model.id, model]))
      const modalities = supports(transport, CAPABILITY.IMAGES) && this.canReadImage()
        ? ['text', 'image']
        : ['text']
      models = catalog.map((entry) => {
        const override = overrides.get(entry.id)
        overrides.delete(entry.id)
        const denied = this.denied.get(route)?.has(entry.id) === true
        // The agent's own catalogue may carry a window (`contextWindowMetaPath`);
        // remember it so `resolveModel` meters this route correctly even before
        // the first `usage_update`.
        if (entry.contextWindow !== undefined) {
          this.reportedContext.set(`${route}\u0000${entry.id}`, entry.contextWindow)
        }
        return {
          provider: route,
          id: entry.id,
          name: override?.name ?? entry.name ?? entry.id,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          inputModalities: modalities,
          badge: denied ? DENIED_BADGE : badgeOf(profile),
        }
      })
      // A declared model the agent did not advertise is still offered: the
      // catalogue is advisory, and the agent may accept an id it does not list.
      for (const leftover of overrides.values()) {
        models.push({ provider: route, id: leftover.id, name: leftover.name, inputModalities: modalities, badge: badgeOf(profile) })
      }
    } catch (error) {
      this.logger?.error?.(`dsh-agent-providers: model catalogue for "${route}" failed: ${error.message}`)
      // An agent that needs a session to list models, and a session only after
      // signing in, would otherwise advertise an empty group: nothing to select,
      // so no way to reach the message that explains the sign-in.
      models = this.fallbackModels(profile)
    }
    this.catalogs.set(route, { at: Date.now(), models })
    return models
  }

  /** @param {any} profile */
  declaredModels(profile) {
    return profile.models.map((model) => ({
      provider: profile.route,
      id: model.id,
      name: model.name,
      inputModalities: this.modalitiesOf(profile),
      badge: badgeOf(profile),
    }))
  }

  /**
   * The stand-in catalogue for a route whose real one cannot be read yet.
   * @param {any} profile
   */
  fallbackModels(profile) {
    if (profile.fallbackModel === false) return []
    const declared = profile.fallbackModel
    const id = declared?.id ?? '__dsh_backend_default__'
    const name = declared?.name ?? `${profile.displayName} (sign-in required)`
    return [{
      provider: profile.route,
      id,
      name,
      inputModalities: ['text'],
      badge: { text: { en: 'sign-in required', zh: '需要登录' }, tone: 'warning' },
    }]
  }

  /** Token modalities this route can actually accept. */
  modalitiesOf(profile) {
    return this.imagesFor(profile) === undefined ? ['text'] : ['text', 'image']
  }

  /**
   * The image reader for one route, or undefined when this composition cannot
   * produce image bytes. Declaring image input without forwarding it would make
   * DSH accept an image the agent never receives.
   */
  imagesFor(profile) {
    const known = [...this.transports.values()].map(entry => entry.transport).filter(transport => transport?.profile.route === profile.route && !transport.closed)
    return this.canReadImage() && known.length && known.every(transport => supports(transport, CAPABILITY.IMAGES)) ? profile : undefined
  }

  /**
   * Read one route's catalogue so its advertised windows are known, even when
   * nothing has asked for the model list. Failures are swallowed: metering falls
   * back rather than failing a turn, and `listModels` already caches the failure
   * for its own retry window.
   *
   * @param {string} route
   */
  async hydrateCatalogue(route) {
    const inflight = this.catalogProbes.get(route)
    if (inflight !== undefined) return inflight
    const probe = this.listModels(route)
      .then(() => {}, () => {})
      .finally(() => { this.catalogProbes.delete(route) })
    this.catalogProbes.set(route, probe)
    return probe
  }

  /**
   * @param {string} route
   * @param {string} model
   */
  async resolveModel(route, model) {
    const profile = this.current().profiles.get(route)
    const declared = profile?.models.find((candidate) => candidate.id === model)
    // Precedence: what the profile declares, then what the agent measured at
    // runtime (`usage_update`), then what its catalogue advertised, then the
    // route default, then the neutral fallback. Measured outranks advertised
    // because the catalogue can be stale — TRAE CLI lists one model at 200k and
    // then reports 950k for it — and the profile outranks both because pinning
    // a window is an explicit decision.
    const key = `${route}\u0000${model}`
    const learned = this.learnedContext.get(key)
    let reported = this.reportedContext.get(key)
    // The catalogue is where the agent publishes its windows, but reading it
    // used to be the picker's job (`listModels`) — a headless run never lists
    // models, so metering silently used the route default for the whole first
    // turn. Fill it here instead, once per route: the probe is cached by
    // `listModels`, so this costs nothing after the first lookup.
    //
    // Two recipes can carry a window, and both need this: an ACP agent that
    // publishes it inside a catalogue entry (`contextWindowMetaPath`), and a CLI
    // whose own catalogue command prints it (`catalogCommand`). A CLI route has
    // no `_meta` to point at, so without the second condition its live window
    // would reach the meter only after something opened the picker.
    const catalogueCarriesWindows = profile?.contextWindowMetaPath !== undefined
      || (profile?.cli?.catalogCommand?.length ?? 0) > 0
    if (reported === undefined && declared?.contextWindow === undefined && learned === undefined
      && catalogueCarriesWindows) {
      await this.hydrateCatalogue(route)
      reported = this.reportedContext.get(key)
    }
    const contextWindow = declared?.contextWindow
      ?? learned
      ?? reported
      ?? profile?.defaultContextWindow
      ?? DEFAULT_CONTEXT_WINDOW
    const maxTokens = declared?.maxTokens ?? profile?.defaultMaxTokens
    return {
      provider: route,
      id: model,
      name: declared?.name ?? model,
      context: { contextWindow },
      ...(maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens }),
    }
  }

  /**
   * The approval handler for one turn, or `undefined` when this route resolves
   * permission itself (`allow` / `reject`) or the host has no approval channel.
   *
   * The handler is per-turn on purpose: the harness approval service audits a
   * question onto the turn that asked it and routes the prompt to that turn's
   * UI, so a handler cached across turns would ask on the wrong one.
   *
   * @param {any} options
   * @param {any} profile
   */
  approvalFor(options, profile) {
    if (profile.permission !== 'ask') return undefined
    const ask = this.askApproval
    if (ask === undefined) return undefined
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    return (request) => ask({ sessionId, ...request })
  }

  /** @param {any} options */
  async *stream(options) {
    const { profiles, maxReplayChars } = this.current()
    const profile = profiles.get(options.provider)
    if (profile === undefined) {
      throw new LlmError(`no agent backend is configured for provider "${options.provider}"`, 'NO_ADAPTER')
    }
    // An auxiliary producer would each cost a full agent run. A title is cheap
    // to answer locally and the harness shows the result, so do that; anything
    // else — a compaction summary, say — must not be faked.
    if (options.purpose !== undefined) {
      const purpose = String(options.purpose)
      if (purpose.includes('title')) {
        const title = localTitle(options)
        if (title.length > 0) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: title }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      throw new Error(
        `dsh-agent-providers: provider "${options.provider}" cannot serve the auxiliary purpose "${purpose}"`,
      )
    }

    const dshSessionId = options.sessionId === undefined ? `ephemeral-${randomUUID()}` : String(options.sessionId)
    throwIfAborted(options.signal)
    if (this.disposed) throw new Error('agent provider was disposed')
    const controller = new AbortController()
    this.queuedControllers.add(controller)
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    const key = `${options.provider}\u0000${dshSessionId}`
    let runId
    const active = { controller, runId, profile, started: false }
    // Queued turns cannot overwrite the cancellation target of the live one.
    let release
    let admission
    try {
      runId = await this.activity?.begin({ dshSessionId, route: profile.route, displayName: profile.displayName,
        cwd: profile.cwd ?? this.resolveCwd(options.sessionId), requestedModel: options.model, title: localTitle(options) })
      active.runId = runId
      if (runId) this.runControllers.set(runId, { ...active, dshSessionId })
      release = await this.lock(dshSessionId, options.provider, controller.signal)
      if (this.disposed) throw abortError('provider disposed while queued')
      this.activeRuns.set(key, active)
      this.activity?.update(runId, { status: 'queued' })
      const group = this.admissions.get(profile.route) ?? new Semaphore(profile.maxConcurrentTurns ?? 2)
      this.admissions.set(profile.route, group)
      admission = await group.acquire(controller.signal)
      active.started = true
      yield* this.run({ ...options, signal: controller.signal, runId }, profile, dshSessionId, maxReplayChars)
    } catch (error) {
      await this.activity?.settle(runId, error.name === 'AbortError' ? 'cancelled' : 'failed', error).catch(() => {})
      throw error
    } finally {
      controller.abort()
      this.queuedControllers.delete(controller)
      if (runId) this.runControllers.delete(runId)
      options.signal?.removeEventListener('abort', abort)
      admission?.(); release?.()
      if (this.activeRuns.get(key) === active) this.activeRuns.delete(key)
    }
  }

  /**
   * Drive one turn.
   * @param {any} options
   * @param {any} profile
   * @param {string} dshSessionId
   * @param {number} maxReplayChars
   */
  async *run(options, profile, dshSessionId, maxReplayChars) {
    const writer = new ChunkWriter(profile.showToolActivity)
    const cwd = profile.cwd ?? this.resolveCwd(options.sessionId)
    const binding = options.sessionId === undefined ? undefined : await this.registry.get(dshSessionId, profile.route)
    let session
    let settled
    let committed = false
    let finished = false
    let promptStarted = false
    try {
      throwIfAborted(options.signal)
      this.activity?.update(options.runId, { status: 'starting', executionStartedAt: Date.now() })
      if (!this.transports.has(`${profile.route}\u0000${cwd}`)) {
        writer.pushThought(`Starting ${profile.displayName}…\n`)
        for (const chunk of writer.drain()) yield chunk
      }
      const transport = await raceAbort(this.transportFor(profile, cwd), options.signal)
      throwIfAborted(options.signal)
      const userTexts = humanUserTexts(options)
      const decision = continuityDecision(options, binding)
      const sameCliModel = profile.transport !== 'cli' || (binding?.requestedModel ?? binding?.model) === options.model
      const sameGeneration = !binding?.generation || binding.generation === transport.generation
      let resumable = sameGeneration && profile.continuity !== 'replay' && supports(transport, CAPABILITY.RESUME)
        && binding?.cwd === cwd && decision.resume && sameCliModel
      const acquireSession = async (promise) => {
        const acquired = await promise
        if (options.signal?.aborted) { await acquired.close('cancelled during setup'); throw abortError() }
        return acquired
      }
      if (resumable) {
        try { session = await acquireSession(transport.resume(binding.externalSessionId, { cwd, signal: options.signal })) }
        catch (error) {
          throwIfAborted(options.signal)
          if (error.code === 'SESSION_IN_USE') throw error
          resumable = false
          this.activity?.notice(options.runId, 'Stored session could not be restored; history is being replayed.')
          session = await acquireSession(transport.create({ cwd, signal: options.signal }))
        }
      } else {
        if (binding) this.activity?.notice(options.runId, decision.reason === 'handoff'
          ? 'Context from another agent is being handed off through a full replay.' : 'Conversation history is being replayed into a new agent session.')
        session = await acquireSession(transport.create({ cwd, signal: options.signal }))
      }
      throwIfAborted(options.signal)
      // Model selection precedes effort/mode, whose options may depend on it.
      if (typeof options.model === 'string' && options.model.length > 0) await session.selectModel(options.model, { signal: options.signal })
      const wantedConfig = { ...profile.configOptions, ...(sameGeneration ? binding?.sessionConfig : {}) }
      await session.applyConfig?.(wantedConfig, { signal: options.signal, selectProfileModel: !options.model })
      const active = this.activeRuns.get(`${profile.route}\u0000${dshSessionId}`)
      if (active) { active.externalId = session.externalId; active.cwd = cwd }
      this.activity?.update(options.runId, { externalSessionId: session.externalId, actualModel: session.selectedModel,
        modelConfirmed: session.selectedModel !== undefined, status: 'running' })
      if (session.configOptions) this.activity?.accept(options.runId, { type: 'config', options: session.configOptions })
      if (options.sessionId !== undefined && session.selectedModel === undefined) this.activity?.notice(options.runId,
        'The backend has not confirmed its actual model; the requested selection is shown separately.')
      const text = resumable ? renderDelta(options) : renderTranscript(options, maxReplayChars)
      const prompt = text || renderTranscript(options, maxReplayChars)
      const images = await this.imagesForPrompt(options, session, !resumable)
      throwIfAborted(options.signal)
      const channel = new Channel()
      let failure
      let outcome
      const approve = this.approvalFor(options, profile)
      // Invalidate before starting: partial tools, Stop, and crash must never resume an old witness.
      if (options.sessionId !== undefined && binding) await this.registry.drop(dshSessionId, profile.route)
      promptStarted = true
      settled = Promise.resolve().then(() => session.prompt({ text: prompt,
        ...(images === undefined ? {} : { images }), ...(approve === undefined ? {} : { approve }),
        signal: options.signal,
        onUpdate: (event) => {
          this.activity?.accept(options.runId, event)
          if (event.type === 'context') {
            if (session.selectedModel) this.learnedContext.set(`${profile.route}\u0000${session.selectedModel}`, event.size)
            return
          }
          writer.accept(event)
          for (const chunk of writer.drain()) channel.push(chunk)
        },
      })).then((value) => { outcome = value }).catch((error) => { failure = error }).finally(() => channel.close())
      for await (const chunk of channel) yield chunk
      await settled
      if (failure) throw failure
      throwIfAborted(options.signal)
      if (this.denied.get(profile.route)?.delete(options.model)) this.catalogs.delete(profile.route)
      const finish = finishFor(outcome?.stopReason ?? STOP_REASON.UNKNOWN, outcome)
      if (session.configOptions) this.activity?.accept(options.runId, { type: 'config', options: session.configOptions, actualModel: session.selectedModel })
      this.activity?.update(options.runId, { status: 'finalizing' })
      if (supports(transport, CAPABILITY.RESUME) && options.sessionId !== undefined && outcome?.stopReason === STOP_REASON.END_TURN) {
        try {
          await this.registry.set(dshSessionId, profile.route, new SessionBinding({ externalSessionId: session.externalId, cwd,
            sentUserCount: userTexts.length, sentUserDigest: userHistoryDigest(userTexts, userTexts.length),
            ...conversationWitness(options, writer.text?.text ?? ''), model: session.selectedModel,
            requestedModel: options.model, sessionConfig: sameGeneration ? binding?.sessionConfig ?? {} : {}, forkedFrom: binding?.forkedFrom,
            generation: transport.generation, configOptions: session.configOptions, capabilities: [...session.capabilities],
            lastPromptAt: Date.now() }))
        } catch (error) {
          this.activity?.notice(options.runId, `Task completed, but its session binding could not be saved. Do not repeat executed actions: ${redactText(error.message)}`)
          this.activity?.update(options.runId, { bindingPersistenceError: redactText(error.message) })
        }
      }
      committed = true
      await this.activity?.verify(options.runId)
      await this.activity?.settle(options.runId, finish.kind === 'stop' ? 'completed' : finish.kind === 'aborted' ? 'cancelled' : 'failed', finish.failure, outcome?.usage)
      // Persistence precedes all terminal output, even consumers that stop at finish.
      for (const chunk of writer.close()) yield chunk
      if (outcome?.usage) yield { type: 'usage', usage: outcome.usage }
      finished = true
      yield { type: 'finish', reason: finish }
    } catch (error) {
      if (isAccessDenial(error.message) && typeof options.model === 'string' && !/^APPROVAL/.test(error.code ?? '')) {
        const denied = this.denied.get(profile.route) ?? new Set(); denied.add(options.model)
        this.denied.set(profile.route, denied); this.catalogs.delete(profile.route)
      }
      const executionStatus = error.executionUnknown ? 'unknown' : options.signal?.aborted ? 'cancelled' : 'failed'
      await this.activity?.settle(options.runId, executionStatus, error).catch(() => {})
      for (const chunk of writer.close()) yield chunk
      throw safeError(error)
    } finally {
      if (!finished && !committed) {
        // Iterator return is a cancellation too. The transport observes the same signal.
        const active = this.activeRuns.get(`${profile.route}\u0000${dshSessionId}`)
        active?.controller.abort()
        if (settled) await settled
        if (promptStarted && options.sessionId !== undefined) await this.registry.drop(dshSessionId, profile.route).catch(() => {})
        await this.activity?.settle(options.runId, 'interrupted').catch(() => {})
      }
      if (session) await session.close('turn finished').catch(() => {})
    }
  }

  /**
   * Get or create the transport for one (route, cwd) pair. Concurrent asks
   * share one process.
   * @param {any} profile
   * @param {string} cwd
   */
  async transportFor(profile, cwd) {
    if (this.disposed) throw new Error('agent provider was disposed')
    const fingerprint = JSON.stringify(profile)
    const previous = this.profileFingerprints.get(profile.route)
    if (previous && previous !== fingerprint) await this.reconcile()
    this.profileFingerprints.set(profile.route, fingerprint)
    const key = `${profile.route}\u0000${cwd}`
    const resolvedEnv = await resolveEnv(profile, this.credentials)
    const generation = profileGeneration({ ...profile, env: resolvedEnv })
    const existing = this.transports.get(key)
    if (existing !== undefined) {
      const transport = await existing.promise
      if (transport.closed !== true && transport.generation === generation) return transport
      await transport.close('account configuration changed; old bindings will not be resumed')
      this.transports.delete(key)
      this.catalogs.delete(profile.route)
    }
    const promise = createTransport({ ...profile, credentials: {}, env: resolvedEnv }, {
      cwd,
      // Pass the resolver through as-is: wrapping it here would hide the
      // diagnostics a composition-level resolver carries.
      credentials: this.credentials,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      resolveExecutable: this.resolveExecutable,
      ...(this.diagnostics === undefined ? {} : { diagnostics: this.diagnostics }),
    }).then(transport => { transport.generation = generation; return transport }).catch((error) => {
      this.transports.delete(key)
      throw error
    })
    const entry = { promise }
    this.transports.set(key, entry)
    const transport = await promise
    if (this.transports.get(key) !== entry || this.disposed) {
      await transport.close('stale configuration')
      throw new Error('agent configuration changed during startup')
    }
    transport.generation = generation
    entry.transport = transport
    return transport
  }

  /**
   * Read the current turn's image attachments into bytes a transport can send.
   *
   * Returns `undefined` when the route cannot carry images, so the transport
   * falls back to the text note the prompt rendering already produced.
   *
   * @returns {Promise<Array<{ mediaType: string, data: Uint8Array }> | undefined>}
   */
  async imagesForPrompt(options, session, replay = false) {
    if (this.readImage === undefined || !session.capabilities.has(CAPABILITY.IMAGES)) return undefined
    const messages = options.messages ?? []
    let start = 0
    if (!replay) for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].role === 'assistant') start = index + 1
    }
    const refs = []
    for (const message of messages.slice(start)) {
      if (message.role !== 'user') continue
      for (const block of message.content ?? []) {
        if (block?.type === 'image' && block.offloaded !== true && block.attachment !== undefined) {
          refs.push(block.attachment)
        }
      }
    }
    if (refs.length === 0) return undefined
    if (refs.length > MAX_PROMPT_IMAGES) {
      this.activity?.notice(options.runId, `Only ${MAX_PROMPT_IMAGES} image attachments can be forwarded in one turn.`)
      throw new LlmError(`too many image attachments (maximum ${MAX_PROMPT_IMAGES}); split the request`, 'ATTACHMENT_LIMIT')
    }
    const images = []
    for (const ref of refs.slice(0, MAX_PROMPT_IMAGES)) {
      try {
        const stored = await this.readImage(ref, options.signal)
        images.push({ mediaType: ref.mediaType, data: stored.data })
      } catch (error) {
        throwIfAborted(options.signal)
        this.activity?.notice(options.runId, 'An image attachment could not be forwarded.')
        throw new LlmError(`could not read an image attachment: ${error.message}`, 'ATTACHMENT')
      }
    }
    return images.length === 0 ? undefined : images
  }

  /** Release every transport and its processes. */
  async dispose() {
    this.disposed = true
    for (const controller of this.queuedControllers) controller.abort()
    for (const active of this.activeRuns.values()) active.controller.abort()
    for (const [key, entry] of this.transports) {
      this.transports.delete(key)
      try {
        const transport = entry.transport ?? await entry.promise
        await transport.close('plugin disposed')
      } catch {
        // A transport that never started has nothing to close.
      }
    }
  }

  /**
   * Serialize every prompt for one (Session, route) pair: one external
   * conversation cannot run two turns at once.
   * @returns a release function the caller must invoke.
   */
  async lock(dshSessionId, route, signal) {
    const key = `${route}\u0000${dshSessionId}`
    const prior = this.locks.get(key) ?? Promise.resolve()
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const tail = prior.then(() => gate)
    this.locks.set(key, tail)
    const release = () => {
      releaseGate()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
    try { await raceAbort(prior, signal); throwIfAborted(signal) } catch (error) { release(); throw error }
    return release
  }

  isBusy(dshSessionId, route) { return this.activeRuns.has(`${route}\u0000${dshSessionId}`) || this.locks.has(`${route}\u0000${dshSessionId}`) }
  cancel(dshSessionId, route, runId) {
    const active = runId ? this.runControllers.get(runId) : this.activeRuns.get(`${route}\u0000${dshSessionId}`)
    if (!active || (runId && (active.dshSessionId !== dshSessionId || active.profile.route !== route))) return false
    this.activity?.update(active.runId, { status: 'cancelling' })
    active.controller.abort(); return true
  }

  async reconcile() {
    const profiles = this.current().profiles
    for (const [route, previous] of this.profileFingerprints) {
      const profile = profiles.get(route)
      if (profile && JSON.stringify(profile) === previous) continue
      for (const active of this.runControllers.values()) if (active.profile.route === route) active.controller.abort()
      for (const [key, entry] of this.transports) if (key.startsWith(`${route}\u0000`)) {
        this.transports.delete(key)
        const transport = await entry.promise.catch(() => undefined)
        await transport?.close('configuration changed')
      }
      this.catalogs.delete(route); this.catalogInflight.delete(route); this.profileFingerprints.delete(route)
      this.admissions.delete(route)
      for (const map of [this.learnedContext, this.reportedContext]) for (const key of map.keys()) if (key.startsWith(`${route}\u0000`)) map.delete(key)
    }
  }
}
