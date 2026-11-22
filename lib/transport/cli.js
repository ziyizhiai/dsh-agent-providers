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
import { CAPABILITY, STOP_REASON, assertSession, assertTransport } from './contract.js'

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

/** Substitute `{prompt}` / `{model}` / `{session}` in one argument template. */
function expand(template, variables) {
  return template.replace(/\{(prompt|model|session)\}/g, (_, name) => String(variables[name] ?? ''))
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
    // A CLI invocation is one turn long, so the model is applied at spawn.
    this.model = modelId
  }

  async prompt(request) {
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
      env: { ...scrubbedParentEnv(), ...profile.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    let stderr = ''
    child.stderr.setEncoding?.('utf8')
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8_000) })
    child.stdin.on('error', () => {})

    const onAbort = () => { try { child.kill('SIGTERM') } catch { /* already gone */ } }
    request.signal?.addEventListener('abort', onAbort, { once: true })

    let usage
    let refused = false
    let sessionDiscovered = false
    const jsonl = recipe.jsonl

    const handleLine = (line) => {
      if (line.trim().length === 0) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        // A CLI that mixes log lines into stdout keeps them out of the answer.
        return
      }
      if (!sessionDiscovered && typeof recipe.sessionIdPath === 'string') {
        const discovered = pick(event, recipe.sessionIdPath)
        if (typeof discovered === 'string' && discovered.length > 0) {
          this.externalId = discovered
          sessionDiscovered = true
        }
      }
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
          request.onUpdate?.({ type: 'tool', title: tool, status: 'started' })
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
        if (typeof input === 'number' && typeof output === 'number') usage = { inputTokens: input, outputTokens: output }
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
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
            handleLine(line)
          }
        } else if (request.onUpdate !== undefined) {
          request.onUpdate({ type: 'text', text: String(chunk) })
        }
      }
      if (profile.format === 'jsonl' && buffer.trim().length > 0) handleLine(buffer)

      const exit = await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode })
          return
        }
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })

      if (request.signal?.aborted === true) return { stopReason: STOP_REASON.CANCELLED }
      if (exit.code !== 0 && !refused) {
        const detail = stderr.trim().length > 0 ? `: ${stderr.trim().split('\n').slice(-3).join(' / ')}` : ''
        throw new Error(`"${profile.command}" exited with code ${exit.code ?? `signal ${exit.signal}`}${detail}`)
      }
      return {
        stopReason: refused ? STOP_REASON.REFUSAL : STOP_REASON.END_TURN,
        ...(usage === undefined ? {} : { usage }),
      }
    } finally {
      request.signal?.removeEventListener('abort', onAbort)
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      this.child = undefined
    }
  }

  async close() {
    try { this.child?.kill('SIGTERM') } catch { /* already gone */ }
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

  /** A CLI cannot enumerate models; the profile's catalogue is authoritative. */
  async catalog() {
    return this.profile.models.map((model) => ({ id: model.id, name: model.name }))
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
}
