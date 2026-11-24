/**
 * Configure-driven CLI transport.
 *
 * This is the seam for agents that do **not** speak ACP. Instead of a new
 * module per agent, one recipe describes how to start it, how to hand it a
 * prompt, how to resume, and where its output lives:
 *
 * ```yaml
 * transport: cli
 * command: traectl
 * args: ['run']
 * promptVia: stdin                 # stdin | arg
 * format: jsonl                    # text | jsonl
 * cli:
 *   resumeArgs: ['--continue', '{session}']
 *   sessionIdPath: session_id
 *   modelArgs: ['--model', '{model}']
 *   catalogCommand: ['traectl', 'models', '--json']   # live model list
 *   catalogJson: { entries: models, id: id, contextWindow: context_length }
 *   jsonl:
 *     text: message.content
 *     reasoning: message.reasoning
 *     tool: message.tool
 *     error: { path: is_error, equals: true }
 *     usage: { input: usage.input_tokens, output: usage.output_tokens }
 * ```
 *
 * Adding such an agent costs configuration, not code. Only an agent whose
 * output structure the recipe language cannot express needs a new transport.
 *
 * Capability honesty: a CLI process is one turn long, so `LIST`, `FORK` and
 * `SWITCH_MODEL` are never advertised. `RESUME` appears only when the recipe
 * supplies both a resume argument and a session-id path. The adapter reads
 * that and degrades instead of promising continuity it cannot keep.
 *
 * @module dsh-agent-providers/transport/cli
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { scrubbedParentEnv } from '../env.js'
import { throwIfAborted, terminateChild } from '../lifecycle.js'
import { safeValue } from '../activity.js'
import { CAPABILITY, STOP_REASON, assertSession, assertTransport } from './contract.js'

/**
 * Default bound for a recipe's catalogue command.
 *
 * Enumerating models is not a prompt: a launcher may sign in and reach a
 * gateway first, but a user staring at an empty model picker should not wait
 * for the full turn timeout before learning the command is stuck.
 */
export const DEFAULT_CATALOG_TIMEOUT_MS = 20_000

/** stdout kept from a catalogue command; a runaway dump must not grow the heap. */
const CATALOG_STDOUT_LIMIT = 1_048_576

/** stderr kept for failure messages, matching the turn path's tail. */
const CATALOG_STDERR_TAIL = 8_000

/**
 * Grace between the catalogue timeout's SIGTERM and a SIGKILL.
 *
 * A launcher that traps SIGTERM would otherwise leave the model picker waiting
 * forever: the timeout error can only surface once the child's stdout closes.
 */
const CATALOG_KILL_GRACE_MS = 2_000

/** Read a dotted path out of a parsed JSON value. */
export function pick(value, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let current = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

/**
 * A positive token count at one dotted path, or undefined when absent.
 *
 * Absence and zero mean the same thing to the harness — no cached tokens to
 * report — so both collapse to "not published" instead of a zero field.
 */
function readCount(value, path) {
  const count = pick(value, path)
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : undefined
}

/**
 * The environment one child starts from.
 *
 * Credentials are already merged into `profile.env` by the transport factory,
 * so the catalogue command and the prompt must see the same world: an agent
 * that authenticates from a mapped credential would otherwise enumerate models
 * it cannot then call.
 */
function childEnvironment(profile) {
  return { ...scrubbedParentEnv(), ...profile.env }
}

/** Substitute `{prompt}` / `{model}` / `{session}` in one argument template. */
function expand(template, variables) {
  return template.replace(/\{(prompt|model|session)\}/g, (_, name) => String(variables[name] ?? ''))
}

/**
 * Parse a catalogue dump, tolerating log lines around the JSON document.
 *
 * The contract is that the command prints JSON, but launchers are made for
 * humans: a banner on the way to the document must not turn a working
 * catalogue into an empty picker.
 *
 * @param {string} stdout
 * @param {string} command
 */
function parseCatalogueJson(stdout, command) {
  const text = stdout.trim()
  if (text.length === 0) {
    throw new Error(`"${command}" catalogue command printed no JSON`)
  }
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch { /* fall through to the named error */ }
    }
  }
  throw new Error(`"${command}" catalogue command did not print JSON`)
}

/**
 * Map one catalogue dump onto the transport contract's model entries.
 *
 * Ids are kept exactly as the vendor wrote them, because `modelArgs` passes
 * them straight back on the command line. An entry whose id is missing or not a
 * string is skipped rather than coerced: inventing an id would offer the picker
 * a model the agent never accepts. The first occurrence of an id wins and the
 * source order is preserved, so a duplicated id cannot reorder the picker.
 *
 * @param {unknown} parsed
 * @param {{ entries?: string, id?: string, name?: string, contextWindow?: string }} mapping
 * @param {string} command
 */
function mapCatalogue(parsed, mapping, command) {
  const entries = pick(parsed, mapping.entries)
  if (!Array.isArray(entries)) {
    throw new Error(`"${command}" catalogue command printed no model array at "${mapping.entries}"`)
  }
  const models = []
  const seen = new Set()
  for (const entry of entries) {
    const id = pick(entry, mapping.id)
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = pick(entry, mapping.name)
    const contextWindow = pick(entry, mapping.contextWindow)
    models.push({
      id,
      name: typeof name === 'string' && name.length > 0 ? name : id,
      ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
        ? { contextWindow }
        : {}),
    })
  }
  return models
}

/** One CLI invocation per turn. */
class CliSession {
  constructor(transport, externalId, resumed) {
    this.transport = transport
    this.externalId = externalId
    this.resumed = resumed
    this.capabilities = transport.capabilities
    this.model = undefined
    this.child = undefined
  }

  async selectModel(modelId) {
    if (!this.transport.profile.cli.modelArgs?.length) {
      if (modelId === 'default') return
      const error = new Error('this CLI recipe does not support model selection'); error.code = 'MODEL_UNSUPPORTED'; throw error
    }
    this.model = modelId
    // Applied at spawn, not a claim about a gateway-resolved underlying model.
    this.selectedModel = undefined
  }

  async prompt(request) {
    throwIfAborted(request.signal)
    const { profile } = this.transport
    const recipe = profile.cli
    const variables = { prompt: request.text, model: this.model ?? '', session: this.externalId }
    const args = [...profile.args]
    if (this.model !== undefined && recipe.modelArgs !== undefined) {
      args.push(...recipe.modelArgs.map((template) => expand(template, variables)))
    }
    const resuming = this.resumed && (recipe.resumeArgs?.length ?? 0) > 0 && this.externalId.length > 0
    if (resuming) args.push(...recipe.resumeArgs.map((template) => expand(template, variables)))
    if (recipe.promptVia === 'arg') args.push(request.text)

    const child = spawn(profile.executable ?? profile.command, args, {
      cwd: this.transport.cwd,
      env: childEnvironment(profile),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    let stderr = ''
    // A missing executable emits `error`, not `exit`; an unhandled 'error' on a
    // ChildProcess throws in the host process, so capture it and fail the turn.
    let spawnError
    child.on('error', (error) => { spawnError = error })
    child.stderr.setEncoding?.('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8_000) })
    child.stdin.on('error', () => {})

    let killCleanup = () => {}
    let timedOut = false
    let idleTimer
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { timedOut = true; killCleanup = terminateChild(child, profile.cancelTimeoutMs ?? 2000) }, profile.eventTimeoutMs)
    }
    armIdle()
    const onAbort = () => { killCleanup = terminateChild(child, profile.cancelTimeoutMs ?? 2000) }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()

    let usage
    let refused = false
    let sessionDiscovered = false
    const jsonl = recipe.jsonl
    let toolCounter = 0

    const handleLine = (line) => {
      if (line.trim().length === 0) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        // A CLI that mixes log lines into stdout keeps them out of the answer.
        return
      }
      armIdle()
      if (!sessionDiscovered && typeof recipe.sessionIdPath === 'string') {
        const discovered = pick(event, recipe.sessionIdPath)
        if (typeof discovered === 'string' && discovered.length > 0) {
          this.transport.sessions.delete(this.externalId)
          this.externalId = discovered
          this.transport.sessions.set(this.externalId, this)
          sessionDiscovered = true
        }
      }
      // Optional fields are data-driven, including actual model reports.
      const reportedModel = pick(event, jsonl?.model)
      if (typeof reportedModel === 'string') { this.selectedModel = reportedModel; request.onUpdate?.({ type: 'model', value: reportedModel }) }
      if (jsonl?.error !== undefined && String(pick(event, jsonl.error.path)) === jsonl.error.equals) {
        refused = true
      }
      if (typeof jsonl?.reasoning === 'string') {
        const reasoning = pick(event, jsonl.reasoning)
        if (typeof reasoning === 'string' && reasoning.length > 0 && !refused) {
          request.onUpdate?.({ type: 'reasoning', text: reasoning })
        }
      }
      if (typeof jsonl?.tool === 'string') {
        const tool = pick(event, jsonl.tool)
        if (typeof tool === 'string' && tool.length > 0) {
          request.onUpdate?.({ type: 'tool', id: String(pick(event, jsonl.toolId) ?? `cli-tool-${++toolCounter}`), title: tool,
            status: pick(event, jsonl.toolStatus) ?? 'started', kind: pick(event, jsonl.toolKind),
            rawInput: safeValue(pick(event, jsonl.toolInput)), rawOutput: safeValue(pick(event, jsonl.toolOutput)) })
        }
      }
      if (typeof jsonl?.text === 'string') {
        const text = pick(event, jsonl.text)
        if (typeof text === 'string' && text.length > 0 && !refused) {
          request.onUpdate?.({ type: 'text', text })
        }
      }
      if (jsonl?.usage !== undefined) {
        const input = pick(event, jsonl.usage.input)
        const output = pick(event, jsonl.usage.output)
        if (typeof input === 'number' && typeof output === 'number') {
          // Cached prompt tokens are counted beside the uncached input the
          // agent already reports, and the harness adds the three up: folding
          // them into `inputTokens` would charge the prompt twice.
          const cacheRead = readCount(event, jsonl.usage.cacheRead)
          const cacheWrite = readCount(event, jsonl.usage.cacheWrite)
          usage = {
            inputTokens: input,
            outputTokens: output,
            ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
          }
        }
      }
    }

    try {
      if (recipe.promptVia !== 'arg') child.stdin.end(request.text)
      else child.stdin.end()

      let buffer = ''
      child.stdout.setEncoding?.('utf8')
      for await (const chunk of child.stdout) {
        if (profile.format === 'jsonl') {
          buffer += String(chunk)
          if (buffer.length > 1048576 && !buffer.includes('\n')) throw new Error('CLI JSONL line exceeds 1 MiB')
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
            handleLine(line)
          }
        } else if (request.onUpdate !== undefined) {
          armIdle()
          request.onUpdate({ type: 'text', text: String(chunk) })
        }
      }
      if (profile.format === 'jsonl' && buffer.trim().length > 0) handleLine(buffer)

      // Report a failed spawn before waiting for `exit`: a child that never
      // started does not emit `exit` on every platform (Node emits `error` and
      // `close` for ENOENT), so the named message must not depend on `exitCode`
      // happening to be set by the time the stdout iterator ends. Checked again
      // after the wait for an error that arrives late.
      if (spawnError !== undefined) {
        throw new Error(`"${profile.command}" failed to start: ${spawnError.message}`)
      }

      const exit = await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode })
          return
        }
        child.once('exit', (code, signal) => resolve({ code, signal }))
        // `close` settles the wait even when only `error`/`close` were emitted;
        // a second resolve is ignored, so the first of the two wins.
        child.once('close', (code, signal) => resolve({ code, signal }))
      })

      if (request.signal?.aborted === true) return { stopReason: STOP_REASON.CANCELLED }
      if (timedOut) { const error = new Error('CLI sent no event before the silence deadline'); error.code = 'EVENT_TIMEOUT'; throw error }
      if (spawnError !== undefined) {
        throw new Error(`"${profile.command}" failed to start: ${spawnError.message}`)
      }
      if (exit.code !== 0 && !refused) {
        const detail = stderr.trim().length > 0 ? `: ${stderr.trim().split('\n').slice(-3).join(' / ')}` : ''
        throw new Error(`"${profile.command}" exited with code ${exit.code ?? `signal ${exit.signal}`}${detail}`)
      }
      return {
        stopReason: refused ? STOP_REASON.REFUSAL : STOP_REASON.END_TURN,
        ...(usage === undefined ? {} : { usage }),
      }
    } finally {
      clearTimeout(idleTimer)
      request.signal?.removeEventListener('abort', onAbort)
      if (child.exitCode !== null || child.signalCode !== null) killCleanup()
      else terminateChild(child, profile.cancelTimeoutMs ?? 2000)
      this.child = undefined
    }
  }

  async close() {
    terminateChild(this.child, this.transport.profile.cancelTimeoutMs ?? 2000)
    this.transport.sessions.delete(this.externalId)
  }
}

export class CliTransport {
  /**
   * @param {any} profile
   * @param {string} cwd
   * @param {{ logger?: any }} [options]
   */
  constructor(profile, cwd, options = {}) {
    this.kind = 'cli'
    this.profile = profile
    this.cwd = cwd
    this.logger = options.logger
    this.sessions = new Map()
    this.closed = false
    const recipe = profile.cli
    // A CLI streams bytes as they arrive in either output format.
    this.capabilities = new Set([CAPABILITY.STREAM])
    // `resumeArgs` defaults to an empty array through the schema, so presence
    // alone is not evidence: a resume needs both a non-empty template list and
    // a way to learn the id it should receive.
    if ((recipe.resumeArgs?.length ?? 0) > 0 && typeof recipe.sessionIdPath === 'string') {
      this.capabilities.add(CAPABILITY.RESUME)
    }
    // One process per turn: there is nothing to enumerate, branch, or retune
    // inside a live conversation.
  }

  /**
   * Advertise the models this agent offers.
   *
   * A recipe without `catalogCommand` keeps the historical reading: the
   * declared catalogue is authoritative, and a CLI is never spawned just to
   * list models. A recipe with one asks the vendor instead, because a
   * gateway-scoped catalogue is the only thing that knows what this account may
   * actually call — a copied list would drift silently.
   *
   * @param {{ cwd?: string, signal?: AbortSignal }} [options]
   */
  async catalog(options = {}) {
    const recipe = this.profile.cli ?? {}
    const argv = recipe.catalogCommand
    if (!Array.isArray(argv) || argv.length === 0) {
      return this.profile.models.map((model) => ({ id: model.id, name: model.name }))
    }
    const parsed = await this.runCatalogCommand(argv, recipe, options)
    return mapCatalogue(parsed, recipe.catalogJson ?? {}, argv[0])
  }

  /**
   * Run one catalogue command and return its parsed JSON document.
   *
   * Deliberately separate from `prompt`: this is not a turn. It gets no
   * session, no prompt argument and a much shorter bound, and its stdout is
   * data rather than an answer — nothing is streamed to the conversation.
   *
   * @param {string[]} argv
   * @param {any} recipe
   * @param {{ cwd?: string, signal?: AbortSignal }} options
   */
  async runCatalogCommand(argv, recipe, options) {
    throwIfAborted(options.signal)
    const command = argv[0]
    const timeoutMs = recipe.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
    const child = spawn(command, argv.slice(1), {
      cwd: options.cwd ?? this.cwd,
      env: childEnvironment(this.profile),
      // The catalogue command takes no input; an open pipe would only make a
      // launcher that reads stdin until EOF hang instead of printing.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    // A missing executable emits `error` instead of `exit`; without a listener
    // that is an uncaught exception in the host process, so capture it and turn
    // it into a normal rejection naming the command.
    let spawnError
    child.on('error', (error) => { spawnError = error })
    const spawnFailure = () => new Error(`"${command}" catalogue command failed to start: ${spawnError.message}`)
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      // Escalate once, unref'd so a stuck child never holds the host open by
      // itself. Without this, a launcher that traps SIGTERM would leave the
      // picker hanging with no way to reach the timeout error below.
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } },
        CATALOG_KILL_GRACE_MS)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()

    const onAbort = () => { terminateChild(child, CATALOG_KILL_GRACE_MS) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    try {
      child.stderr.setEncoding?.('utf8')
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-CATALOG_STDERR_TAIL) })
      child.stdout.setEncoding?.('utf8')
      for await (const chunk of child.stdout) {
        if (stdout.length >= CATALOG_STDOUT_LIMIT) continue
        stdout += String(chunk).slice(0, CATALOG_STDOUT_LIMIT - stdout.length)
      }

      // Report a failed spawn before waiting for `exit`: a child that never
      // started does not emit `exit` on every platform (Node emits `error` and
      // `close` for ENOENT), and relying on `exitCode` already being set here
      // would make the ordering fragile. Checked again after the wait below for
      // an error that arrives late.
      if (spawnError !== undefined) throw spawnFailure()

      const exit = await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode })
          return
        }
        child.once('exit', (code, signal) => resolve({ code, signal }))
        // `close` settles the wait even when only `error`/`close` were emitted;
        // a second resolve is ignored, so the first of the two wins.
        child.once('close', (code, signal) => resolve({ code, signal }))
      })

      if (options.signal?.aborted === true) {
        throw new Error(`"${command}" catalogue command was cancelled`)
      }
      if (timedOut) {
        throw new Error(`"${command}" catalogue command timed out after ${timeoutMs}ms`)
      }
      if (spawnError !== undefined) throw spawnFailure()
      if (exit.code !== 0) {
        const detail = stderr.trim().length > 0
          ? `: ${stderr.trim().split('\n').slice(-3).join(' / ')}`
          : ''
        throw new Error(
          `"${command}" catalogue command exited with code ${exit.code ?? `signal ${exit.signal}`}${detail}`,
        )
      }
      return parseCatalogueJson(stdout, command)
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      clearTimeout(killTimer)
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  }

  async create() {
    const session = new CliSession(this, `cli-${randomUUID()}`, false)
    this.sessions.set(session.externalId, session)
    return assertSession(session, this.kind)
  }

  async resume(externalId) {
    const session = new CliSession(this, externalId, true)
    this.sessions.set(externalId, session)
    return assertSession(session, this.kind)
  }

  async list() {
    return []
  }

  /** A one-process-per-turn CLI has no session store to branch. */
  async fork() {
    throw new Error('the "cli" transport cannot fork sessions')
  }

  /** Nothing is held open between turns, so there is nothing to release. */
  async closeSession() {}

  /** The CLI owns its own session files; the harness must not delete them. */
  async deleteSession() {
    throw new Error('the "cli" transport cannot delete sessions')
  }

  async close() {
    this.closed = true
    for (const session of [...this.sessions.values()]) await session.close()
    this.sessions.clear()
  }
}

/** Validate one `cli` recipe before it is used, so a typo fails at load. */
export function assertCliRecipe(route, profile) {
  const recipe = profile.cli
  if (recipe === undefined) {
    throw new Error(`dsh-agent-providers: agent "${route}" uses transport "cli" but declares no cli recipe`)
  }
  if (recipe.promptVia !== 'stdin' && recipe.promptVia !== 'arg') {
    throw new Error(`dsh-agent-providers: agent "${route}" needs cli.promptVia "stdin" or "arg"`)
  }
  if (profile.format !== 'text' && profile.format !== 'jsonl') {
    throw new Error(`dsh-agent-providers: agent "${route}" needs format "text" or "jsonl"`)
  }
  if (profile.format === 'jsonl' && typeof recipe.jsonl?.text !== 'string') {
    throw new Error(`dsh-agent-providers: agent "${route}" with format "jsonl" needs cli.jsonl.text`)
  }
  if (recipe.sessionIdPath !== undefined && (recipe.resumeArgs?.length ?? 0) === 0) {
    throw new Error(`dsh-agent-providers: agent "${route}" declares cli.sessionIdPath without cli.resumeArgs, so it could never resume`)
  }
  // The schema materializes an omitted `catalogJson` as `{}`, so emptiness — not
  // presence — is what says "the profile configured a catalogue mapping".
  const catalogJson = recipe.catalogJson !== undefined && Object.keys(recipe.catalogJson).length > 0
    ? recipe.catalogJson
    : undefined
  if ((recipe.catalogCommand?.length ?? 0) > 0) {
    if (typeof catalogJson?.entries !== 'string' || typeof catalogJson?.id !== 'string') {
      throw new Error(
        `dsh-agent-providers: agent "${route}" declares cli.catalogCommand without cli.catalogJson.entries and cli.catalogJson.id`,
      )
    }
  } else if (catalogJson !== undefined) {
    throw new Error(
      `dsh-agent-providers: agent "${route}" declares cli.catalogJson without cli.catalogCommand, so nothing would ever run it`,
    )
  } else if (recipe.catalogTimeoutMs !== undefined) {
    throw new Error(
      `dsh-agent-providers: agent "${route}" declares cli.catalogTimeoutMs without cli.catalogCommand, so it would bound nothing`,
    )
  }
  const usage = recipe.jsonl?.usage
  if (usage !== undefined
    && (usage.cacheRead !== undefined || usage.cacheWrite !== undefined)
    && (typeof usage.input !== 'string' || typeof usage.output !== 'string')) {
    throw new Error(
      `dsh-agent-providers: agent "${route}" declares cli.jsonl.usage cache paths without cli.jsonl.usage.input and cli.jsonl.usage.output`,
    )
  }
}
