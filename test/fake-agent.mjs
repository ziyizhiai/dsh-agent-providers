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
 *
 * `FAKE_ACP_PERMISSION=full|allow-only` makes every turn ask the client for
 * permission before proceeding (`allow-only` omits the reject option, the way an
 * agent that only offers "allow" looks); `FAKE_ACP_PERMISSION_LOG=<path>`
 * appends the client's answer so a test can prove which option it picked. An
 * allow answer continues the turn; a reject answer or a cancelled outcome ends
 * it with `stopReason: "cancelled"`, exactly as a real agent does.
 */
import { appendFileSync } from 'node:fs'

const PROTOCOL_VERSION = 1
// ACP's model list carries no window of its own; TRAE CLI is the agent that
// advertises one per model in `_meta`, which is what `contextWindowMetaPath`
// reads. The values differ per model so a test can tell which entry it got.
const MODEL_OPTIONS = [
  { value: 'fake/opus', name: 'Fake Opus', _meta: { trae: { contextWindow: 475_000 } } },
  { value: 'fake/sonnet', name: 'Fake Sonnet', _meta: { trae: { contextWindow: 200_000 } } },
  { value: 'fake/haiku', name: 'Fake Haiku', _meta: { trae: { contextWindow: 116_000 } } },
]
const MODE_OPTIONS = [
  { value: 'build', name: 'build' },
  { value: 'plan', name: 'plan' },
]

/** Set `FAKE_ACP_NO_LOAD=1` to advertise no `loadSession`, like a one-shot agent. */
const SUPPORTS_LOAD = process.env.FAKE_ACP_NO_LOAD !== '1'

/** `FAKE_ACP_PERMISSION=<mode>` makes every turn request permission first. */
const PERMISSION_MODE = process.env.FAKE_ACP_PERMISSION

/** The default per-turn usage: ACP with the cache reported separately. */
const DEFAULT_USAGE = { inputTokens: 120, outputTokens: 7, thoughtTokens: 3, totalTokens: 127, cachedReadTokens: 20 }

/**
 * `FAKE_ACP_USAGE=<json>` replaces the per-turn usage block, so a test can model
 * an agent with a different accounting (one folding cache into `inputTokens`,
 * a write counter, or cache larger than the prompt).
 */
function usageReport() {
  return process.env.FAKE_ACP_USAGE === undefined
    ? DEFAULT_USAGE
    : JSON.parse(process.env.FAKE_ACP_USAGE)
}

let currentModel = 'fake/opus'
let currentMode = 'build'
let sessionCounter = 0
let permissionCounter = 0
let authenticated = false
const sessions = new Map()
/** Permission requests waiting for the client's answer, by request id. */
const pendingPermissions = new Map()

function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

const respond = (id, result) => write({ id, result })
const fail = (id, code, message) => write({ id, error: { code, message } })
const notify = (method, params) => write({ method, params })

function configOptions() {
  const options = [
    { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: currentModel, options: MODEL_OPTIONS },
    { id: 'effort', name: 'Effort', type: 'select', category: 'thought_level', currentValue: 'default', options: [{ value: 'default', name: 'default' }, { value: 'high', name: 'high' }] },
  ]
  // `FAKE_ACP_LEGACY_MODE=1` publishes modes only in the legacy block, which is
  // what Claude Code does; otherwise they appear as a config option too.
  if (process.env.FAKE_ACP_LEGACY_MODE !== '1') {
    options.push({ id: 'mode', name: 'Session Mode', type: 'select', category: 'mode', currentValue: currentMode, options: MODE_OPTIONS })
  }
  return options
}

/** `FAKE_ACP_CONFIG=<path>` appends one JSON line per applied configuration. */
function recordConfig(entry) {
  if (process.env.FAKE_ACP_CONFIG !== undefined) {
    appendFileSync(process.env.FAKE_ACP_CONFIG, `${JSON.stringify(entry)}\n`)
  }
}

function update(sessionId, payload) {
  notify('session/update', { sessionId, update: payload })
}

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : []
  return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/** Record the client's permission answer, for a test to inspect. */
function recordPermissionAnswer(result) {
  if (process.env.FAKE_ACP_PERMISSION_LOG === undefined) return
  const outcome = result?.outcome?.outcome ?? 'invalid'
  const entry = outcome === 'selected'
    ? { outcome, optionId: result?.outcome?.optionId ?? null }
    : { outcome }
  appendFileSync(process.env.FAKE_ACP_PERMISSION_LOG, `${JSON.stringify(entry)}\n`)
}

/** True when the client granted the request. */
function granted(result) {
  return result?.outcome?.outcome === 'selected' && result?.outcome?.optionId === 'approved'
}

/**
 * Ask the client for permission and wait for its answer.
 *
 * `allow-only` offers no reject option, which is the case where a deny has to be
 * expressed as a `cancelled` outcome instead of a rejected option.
 */
function requestPermission(sessionId, mode) {
  permissionCounter += 1
  const requestId = `fake-permission-${permissionCounter}`
  const options = mode === 'allow-only'
    ? [{ optionId: 'approved', name: 'Allow once', kind: 'allow_once' }]
    : [
        { optionId: 'approved', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'abort', name: 'Reject', kind: 'reject_once' },
      ]
  write({
    id: requestId,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: {
        toolCallId: 'perm-1',
        title: 'Edit src/app.ts',
        kind: 'edit',
        status: 'pending',
        // The detail an agent attaches to the question; the transport turns it
        // into the approval reason/display text.
        content: [{ type: 'content', content: { type: 'text', text: 'Write the generated patch to src/app.ts' } }],
      },
      options,
    },
  })
  return new Promise((resolve) => { pendingPermissions.set(requestId, resolve) })
}

/**
 * `FAKE_ACP_SILENCE_MS=<ms>` makes a turn accept the prompt and then stay silent
 * for that long, so a test can prove the transport's silence watchdog trips.
 * `FAKE_ACP_PACING_MS=<ms>` (with `FAKE_ACP_PACING_STEPS`) spreads a turn's
 * events out, so its total duration can exceed the bound while every gap stays
 * under it — the case only a silence-based bound survives.
 */
const SILENCE_MS = process.env.FAKE_ACP_SILENCE_MS === undefined ? undefined : Number(process.env.FAKE_ACP_SILENCE_MS)
const PACING_MS = process.env.FAKE_ACP_PACING_MS === undefined ? undefined : Number(process.env.FAKE_ACP_PACING_MS)
const PACING_STEPS = Number(process.env.FAKE_ACP_PACING_STEPS ?? 5)

/** Wait without touching the wire. */
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function runTurn(id, params) {
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

  if (PERMISSION_MODE !== undefined) {
    const grantedOnce = await requestPermission(sessionId, PERMISSION_MODE)
    if (!grantedOnce) {
      // A denied or withdrawn permission ends the turn, as a cancelled one does.
      respond(id, { stopReason: 'cancelled', usage: usageReport() })
      return
    }
  }

  if (SILENCE_MS !== undefined) await delay(SILENCE_MS)

  if (PACING_MS !== undefined) {
    for (let step = 0; step < PACING_STEPS; step += 1) {
      await delay(PACING_MS)
      update(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `step ${step + 1} ` },
      })
    }
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
    usage: usageReport(),
  })
}

function handle(request) {
  const { id, method, params } = request

  if (method === 'session/cancel') {
    // A notification, so record it instead of answering: the tests prove the
    // transport told a silent agent to stop, rather than inspecting why.
    recordConfig({ method, sessionId: params?.sessionId })
    return
  }

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
        // A mode where the agent refuses sessions until `authenticate`, which is
        // how Codex behaves; otherwise it advertises nothing and is left alone.
        authMethods: process.env.FAKE_ACP_AUTH === '1'
          ? [{ id: 'api-key', name: 'API Key' }]
          : [{ id: 'fake-login', name: 'Fake login' }],
        agentInfo: { name: 'Fake Agent', version: '1.0.0' },
      })
      return

    case 'authenticate':
      if (process.env.FAKE_ACP_AUTH === '1') {
        const supplied = params?._meta?.['api-key']?.apiKey
        if (typeof supplied !== 'string' || supplied.length === 0) {
          fail(id, -32602, 'authenticate: missing _meta["api-key"].apiKey')
          return
        }
        authenticated = true
      }
      respond(id, {})
      return

    case 'session/new': {
      if (process.env.FAKE_ACP_AUTH === '1' && !authenticated) {
        // The shape Codex uses: refuse until the client signs in.
        fail(id, -32000, 'Authentication required')
        return
      }
      sessionCounter += 1
      const sessionId = `fake-session-${sessionCounter}`
      sessions.set(sessionId, { cwd: params?.cwd, model: currentModel })
      respond(id, {
        sessionId,
        configOptions: configOptions(),
        // Legacy mode block, still published beside config options by some agents.
        modes: {
          currentModeId: 'auto',
          availableModes: [
            { id: 'default', name: 'Manual' },
            { id: 'plan', name: 'Plan' },
            { id: 'auto', name: 'Auto' },
          ],
        },
      })
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

    case 'session/set_mode': {
      recordConfig({ method: 'session/set_mode', modeId: params?.modeId })
      respond(id, {})
      return
    }

    case 'session/set_config_option': {
      recordConfig({ method: 'session/set_config_option', configId: params?.configId, value: params?.value })
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
      // A permission request inside the turn must not block this read loop: the
      // client's answer arrives on the same stream.
      void runTurn(id, params).catch((error) => fail(id, -32603, String(error)))
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
    if (typeof request.method !== 'string') {
      // A response to an agent-initiated request (the permission answer).
      const settle = pendingPermissions.get(request.id)
      if (settle !== undefined) {
        pendingPermissions.delete(request.id)
        recordPermissionAnswer(request.result)
        settle(granted(request.result))
      }
      continue
    }
    try {
      handle(request)
    } catch (error) {
      if (request.id !== undefined) fail(request.id, -32603, String(error))
    }
  }
})
