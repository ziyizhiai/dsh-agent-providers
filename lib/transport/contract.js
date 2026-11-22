/**
 * The transport contract: what a backend must provide to be driven as an
 * external agent, and what the adapter promises it will do with the answers.
 *
 * The adapter knows nothing about protocols. It owns session binding, resume
 * versus replay, prompt rendering, chunk assembly, and the harness lifecycle.
 * A transport owns exactly one thing: talking to one kind of agent.
 *
 * Two transports ship today:
 *
 * - `acp`  — Agent Client Protocol over stdio. Full capability set.
 * - `cli`  — a configure-driven one-shot CLI driver, for agents that have no
 *            ACP support. Reduced capability set; the adapter degrades.
 *
 * Adding a third one (another protocol, a native SDK, an HTTP agent server)
 * means implementing this file's two interfaces and registering a factory.
 * No adapter, config, UI, or test change is required.
 *
 * @module dsh-agent-providers/transport/contract
 */

/**
 * Optional behaviours a transport may advertise. The adapter reads these and
 * degrades instead of failing:
 *
 * - `RESUME`        can reattach to a stored session by external id;
 *                   without it every turn is a full replay.
 * - `LIST`          can enumerate the agent's stored sessions.
 * - `FORK`          can branch one stored session into another.
 * - `SWITCH_MODEL`  can change the model inside a live session; without it a
 *                   model change forces a new session seeded by a replay.
 * - `IMAGES`        accepts image input; without it images degrade to notes.
 * - `STREAM`        emits incremental deltas; without it the whole answer
 *                   arrives as one text delta.
 */
export const CAPABILITY = Object.freeze({
  RESUME: 'resume',
  LIST: 'list',
  FORK: 'fork',
  DELETE: 'delete',
  SWITCH_MODEL: 'switchModel',
  IMAGES: 'images',
  STREAM: 'stream',
})

/** Every capability name, for validation and diagnostics. */
export const CAPABILITIES = Object.freeze(Object.values(CAPABILITY))

/** Terminal reasons every transport must map onto. */
export const STOP_REASON = Object.freeze({
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  CANCELLED: 'cancelled',
  REFUSAL: 'refusal',
  TURN_LIMIT: 'max_turn_requests',
  UNKNOWN: 'unknown',
})

/**
 * Normalized stream events. This union is the ONLY vocabulary the adapter
 * understands, so a new transport never has to learn harness concepts.
 *
 * @typedef {(
 *   | { type: 'text', text: string }
 *   | { type: 'reasoning', text: string }
 *   | { type: 'tool', title: string, status: 'started' | 'completed' | 'failed' }
 *   | { type: 'plan', text: string }
 *   | { type: 'title', title: string }
 *   | { type: 'model', value: string }
 *   | { type: 'context', used: number, size: number }
 *   The agent's own view of the conversation size; `size` is the model's
 *   context window when it reports one. Agents that never send it simply never
 *   tell us, which is why a profile can also declare the window.
  | { type: 'raw', payload: unknown }
 * )} AgentUpdate
 */

/**
 * One live conversation with an external agent.
 *
 * `prompt()` must settle only when the turn is over, and must call `onUpdate`
 * synchronously as events arrive. Implementations must honour `signal` by
 * cancelling the agent's current work and settling promptly.
 *
 * @typedef {object} AgentSession
 * @property {string} externalId - the agent's own id for this conversation.
 * @property {boolean} resumed - whether this handle reattached to stored state.
 * @property {ReadonlySet<string>} capabilities - this session's capabilities.
 * @property {(modelId: string, options: { signal?: AbortSignal }) => Promise<void>} selectModel
 *   Choose the model for the next turn. A transport without `SWITCH_MODEL`
 *   must make this a no-op rather than throw.
 * @property {(request: {
 *   text: string,
 *   images?: readonly { mediaType: string, data: Uint8Array }[],
 *   onUpdate?: (update: AgentUpdate) => void,
 *   signal?: AbortSignal,
 * }) => Promise<{ stopReason: string, usage?: object }>} prompt
 * @property {(reason?: string) => Promise<void>} close
 */

/**
 * One backend that can host sessions.
 *
 * @typedef {object} AgentTransport
 * @property {string} kind - the transport id (`acp`, `cli`, …).
 * @property {ReadonlySet<string>} capabilities - transport-wide capabilities.
 * @property {(options: { cwd: string, signal?: AbortSignal }) => Promise<readonly { id: string, name: string, description?: string }[]>} catalog
 *   The model ids this backend can serve for `cwd`. Called rarely and cached;
 *   may spawn the agent once.
 * @property {(options: { cwd: string, signal?: AbortSignal }) => Promise<AgentSession>} create
 * @property {(externalId: string, options: { cwd: string, signal?: AbortSignal }) => Promise<AgentSession>} resume
 *   Reattach to stored state; only called when `RESUME` is advertised.
 * @property {(externalId: string, options: { cwd: string, signal?: AbortSignal }) => Promise<string>} fork
 *   Branch a stored session, returning the new session's id; only called when
 *   `FORK` is advertised.
 * @property {(externalId: string, options: { cwd: string, signal?: AbortSignal }) => Promise<void>} closeSession
 *   Release the agent's resources for one session without deleting its history.
 * @property {(externalId: string, options: { cwd: string, signal?: AbortSignal }) => Promise<void>} deleteSession
 *   Permanently remove a stored session; only called when `DELETE` is advertised.
 * @property {(options: { cwd: string, signal?: AbortSignal }) => Promise<readonly object[]>} list
 *   Stored sessions; only called when `LIST` is advertised.
 * @property {(reason?: string) => Promise<void>} close
 */

/** A transport or session that violates the contract. */
export class TransportContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TransportContractError'
  }
}

/**
 * Fail fast on a transport that would only misbehave later.
 *
 * @param {unknown} transport
 * @returns {AgentTransport}
 */
export function assertTransport(transport) {
  const candidate = /** @type {any} */ (transport)
  if (candidate === null || typeof candidate !== 'object') {
    throw new TransportContractError('a transport must be an object')
  }
  if (typeof candidate.kind !== 'string' || candidate.kind.length === 0) {
    throw new TransportContractError('a transport needs a non-empty kind')
  }
  for (const method of ['catalog', 'create', 'resume', 'list', 'close']) {
    if (typeof candidate[method] !== 'function') {
      throw new TransportContractError(`transport "${candidate.kind}" is missing ${method}()`)
    }
  }
  if (!(candidate.capabilities instanceof Set)) {
    throw new TransportContractError(`transport "${candidate.kind}" must expose a Set of capabilities`)
  }
  return candidate
}

/**
 * Fail fast on a session handle.
 *
 * @param {unknown} session
 * @param {string} kind
 * @returns {AgentSession}
 */
export function assertSession(session, kind) {
  const candidate = /** @type {any} */ (session)
  if (candidate === null || typeof candidate !== 'object') {
    throw new TransportContractError(`transport "${kind}" returned no session`)
  }
  if (typeof candidate.externalId !== 'string' || candidate.externalId.length === 0) {
    throw new TransportContractError(`transport "${kind}" returned a session without an externalId`)
  }
  for (const method of ['selectModel', 'prompt', 'close']) {
    if (typeof candidate[method] !== 'function') {
      throw new TransportContractError(`transport "${kind}" session is missing ${method}()`)
    }
  }
  return candidate
}

/**
 * Whether a transport advertises one capability.
 * @param {{ capabilities: ReadonlySet<string> } | undefined} owner
 * @param {string} capability
 */
export function supports(owner, capability) {
  return owner?.capabilities.has(capability) === true
}
