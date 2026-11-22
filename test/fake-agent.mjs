/**
 * A minimal, real ACP agent over stdio.
 *
 * Hand-rolled JSON-RPC so the suite needs no agent CLI installed: it answers
 * `initialize`, `session/new`, `session/load`, `session/list`, `session/close`,
 * `session/set_config_option` and `session/prompt`, and reports its model
 * catalogue exactly the way a production agent does — a `select` config option
 * with `category: "model"` whose values are `provider/model` strings.
 *
 * `FAKE_ACP_PROMPTS=<path>` appends one JSON line per received prompt, which the
 * tests use to prove what was actually forwarded.
 */
import { appendFileSync } from 'node:fs'

const PROTOCOL_VERSION = 1
const MODEL_OPTIONS = [
  { value: 'fake/opus', name: 'Fake Opus' },
  { value: 'fake/sonnet', name: 'Fake Sonnet' },
  { value: 'fake/haiku', name: 'Fake Haiku' },
]
const MODE_OPTIONS = [
  { value: 'build', name: 'build' },
  { value: 'plan', name: 'plan' },
]

/** Set `FAKE_ACP_NO_LOAD=1` to advertise no `loadSession`, like a one-shot agent. */
const SUPPORTS_LOAD = process.env.FAKE_ACP_NO_LOAD !== '1'

let currentModel = 'fake/opus'
let currentMode = 'build'
let sessionCounter = 0
const sessions = new Map()

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

const respond = (id, result) => write({ id, result })
const fail = (id, code, message) => write({ id, error: { code, message } })
const notify = (method, params) => write({ method, params })

function configOptions() {
  return [
    { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: currentModel, options: MODEL_OPTIONS },
    { id: 'mode', name: 'Session Mode', type: 'select', category: 'mode', currentValue: currentMode, options: MODE_OPTIONS },
  ]
}

function update(sessionId, payload) {
  notify('session/update', { sessionId, update: payload })
}

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : []
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

function runTurn(id, params) {
  const sessionId = params.sessionId
  if (process.env.FAKE_ACP_DENY === '1') {
    // The shape a real agent returns when the plan does not include a model.
    fail(id, -32603, 'Internal error: Model access is disabled. Change model access at https://example.invalid/go.')
    return
  }
  const text = promptText(params)
  const images = Array.isArray(params?.prompt) ? params.prompt.filter((b) => b?.type === 'image').length : 0

  if (process.env.FAKE_ACP_PROMPTS !== undefined) {
    appendFileSync(process.env.FAKE_ACP_PROMPTS, `${JSON.stringify({ sessionId, text, model: currentModel, images })}\n`)
  }

  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } })
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read src/app.ts', kind: 'read', status: 'in_progress' })
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', title: 'Read src/app.ts' })
  update(sessionId, {
    sessionUpdate: 'plan',
    // ACP's PlanEntry requires all three fields; the client schema drops
    // entries that omit one, so a plan without priority would arrive empty.
    entries: [
      { content: 'inspect the module', priority: 'high', status: 'completed' },
      { content: 'apply the fix', priority: 'medium', status: 'in_progress' },
    ],
  })
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Echo: ' } })
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, 60) } })
  update(sessionId, { sessionUpdate: 'session_info_update', title: 'A renamed session' })
  // ACP's context report; not every agent sends it, but the ones that do let
  // the harness correct its window instead of trusting a default.
  update(sessionId, { sessionUpdate: 'usage_update', used: 4_321, size: 1_000_000 })

  respond(id, {
    stopReason: 'end_turn',
    usage: { inputTokens: 120, outputTokens: 7, thoughtTokens: 3, totalTokens: 127, cachedReadTokens: 20 },
  })
}

function handle(request) {
  const { id, method, params } = request

  if (id === undefined) {
    // Notifications expect no answer.
    return
  }

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          ...(SUPPORTS_LOAD ? { loadSession: true } : {}),
          sessionCapabilities: { list: {}, fork: {}, resume: {}, close: {}, delete: {} },
          promptCapabilities: { image: true, embeddedContext: true },
        },
        authMethods: [{ id: 'fake-login', name: 'Fake login' }],
        agentInfo: { name: 'Fake Agent', version: '1.0.0' },
      })
      return

    case 'session/new': {
      sessionCounter += 1
      const sessionId = `fake-session-${sessionCounter}`
      sessions.set(sessionId, { cwd: params?.cwd, model: currentModel })
      respond(id, { sessionId, configOptions: configOptions() })
      return
    }

    case 'session/load': {
      const sessionId = params?.sessionId
      if (!SUPPORTS_LOAD) {
        fail(id, -32601, 'loadSession is not supported')
        return
      }
      if (!sessions.has(sessionId)) sessions.set(sessionId, { cwd: params?.cwd, model: currentModel })
      // A real agent replays the stored conversation before answering.
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[replayed]' } })
      respond(id, { configOptions: configOptions() })
      return
    }

    case 'session/list':
      respond(id, {
        sessions: [...sessions].map(([sessionId, state]) => ({
          sessionId,
          cwd: state.cwd ?? process.cwd(),
          title: `Session ${sessionId}`,
          updatedAt: new Date().toISOString(),
        })),
      })
      return

    case 'session/set_config_option': {
      if (params?.configId === 'model') {
        if (!MODEL_OPTIONS.some((option) => option.value === params.value)) {
          fail(id, -32602, `unknown model ${params.value}`)
          return
        }
        currentModel = params.value
      }
      if (params?.configId === 'mode') {
        if (!MODE_OPTIONS.some((option) => option.value === params.value)) {
          fail(id, -32602, `unknown mode ${params.value}`)
          return
        }
        currentMode = params.value
      }
      const state = sessions.get(params?.sessionId)
      if (state !== undefined) state.model = currentModel
      respond(id, { configOptions: configOptions() })
      return
    }

    case 'session/prompt':
      runTurn(id, params)
      return

    case 'session/fork': {
      const source = sessions.get(params?.sessionId)
      if (source === undefined) {
        fail(id, -32602, `unknown session ${params?.sessionId}`)
        return
      }
      sessionCounter += 1
      const forked = `fake-session-${sessionCounter}`
      sessions.set(forked, { cwd: source.cwd, model: source.model, forkedFrom: params.sessionId })
      respond(id, { sessionId: forked, configOptions: configOptions() })
      return
    }

    case 'session/close':
    case 'session/delete':
      sessions.delete(params?.sessionId)
      respond(id, {})
      return

    default:
      fail(id, -32601, `unsupported method ${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (line.trim().length === 0) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    try {
      handle(request)
    } catch (error) {
      if (request.id !== undefined) fail(request.id, -32603, String(error))
    }
  }
})
