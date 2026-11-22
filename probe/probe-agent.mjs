/**
 * Describe any ACP agent: capabilities, session configuration, session store.
 *
 * Usage: node probe/probe-agent.mjs <command> [args...]
 *
 *   node probe/probe-agent.mjs claude-agent-acp
 *   node probe/probe-agent.mjs codex-acp
 *   node probe/probe-agent.mjs opencode acp
 *
 * Makes no model request, so it needs no working login: it reports what the
 * agent advertises, which is exactly what the plugin has to adapt to.
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
if (argv.length === 0) {
  console.error('usage: node probe/probe-agent.mjs <command> [args...]')
  process.exit(2)
}

const cwd = process.cwd()
const child = spawn(argv[0], argv.slice(1), {
  cwd,
  env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let nextId = 1
const pending = new Map()
const notifications = []
let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (line.length === 0) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    } else {
      notifications.push(message)
    }
  }
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2_000) })

const request = (method, params, timeoutMs = 60_000) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

const show = (label, value) => {
  console.log(`\n### ${label}`)
  console.log(JSON.stringify(value, null, 2).slice(0, 2_500))
}

try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  if (init.error !== undefined) throw new Error(JSON.stringify(init.error))
  show('initialize', {
    agentInfo: init.result.agentInfo,
    protocolVersion: init.result.protocolVersion,
    capabilities: init.result.agentCapabilities,
    authMethods: (init.result.authMethods ?? []).map((method) => `${method.id}${method.name === undefined ? '' : ` (${method.name})`}`),
  })

  const session = await request('session/new', { cwd, mcpServers: [] })
  if (session.error !== undefined) throw new Error(JSON.stringify(session.error))
  const sessionId = session.result.sessionId
  console.log('\n### session/new')
  console.log('sessionId:', sessionId)
  for (const option of session.result.configOptions ?? []) {
    const values = Array.isArray(option.options) ? option.options : []
    console.log(`  configOption ${option.id} (${option.category ?? 'no category'}, ${option.type}):`,
      `current=${JSON.stringify(option.currentValue)}`, `values=${values.length}`)
    for (const value of values.slice(0, 6)) console.log('    -', value.value ?? value)
    if (values.length > 6) console.log(`    … and ${values.length - 6} more`)
  }
  if (session.result.modes !== undefined) show('modes', session.result.modes)

  const list = await request('session/list', { cwd })
  console.log('\n### session/list →', list.error === undefined ? `${(list.result.sessions ?? []).length} sessions` : JSON.stringify(list.error))

  if (init.result.agentCapabilities?.sessionCapabilities?.fork !== undefined) {
    const forked = await request('session/fork', { sessionId, cwd, mcpServers: [] })
    console.log('### session/fork →', forked.error === undefined ? forked.result.sessionId : JSON.stringify(forked.error))
  }

  const updates = notifications
    .filter((message) => message.method === 'session/update')
    .map((message) => message.params?.update?.sessionUpdate)
  console.log('\n### session/update kinds seen:', [...new Set(updates)].join(', ') || '(none)')
} catch (error) {
  console.log('\nPROBE ERROR:', error.message)
  if (stderr.trim().length > 0) console.log('stderr:', stderr.trim().split('\n').slice(-5).join(' / ').slice(0, 600))
} finally {
  child.kill('SIGKILL')
  process.exit(0)
}
