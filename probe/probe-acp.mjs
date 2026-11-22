/**
 * Time one ACP handshake against the installed opencode, per step.
 *
 * Usage: node probe-acp.mjs <cwd> [model]
 */
import { spawn } from 'node:child_process'

const cwd = process.argv[2] ?? '/root'
const child = spawn('/usr/local/bin/opencode', ['acp'], {
  cwd,
  env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let nextId = 1
const pending = new Map()
let buffer = ''
const started = Date.now()
const mark = (label) => console.log(`${label} @ +${Date.now() - started}ms`)

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
    }
  }
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2000) })
child.on('exit', (code, signal) => mark(`child exit code=${code} signal=${signal}`))

const request = (method, params, timeoutMs = 300_000) => {
  const id = nextId++
  mark(`→ ${method}`)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method} after ${timeoutMs}ms`)), timeoutMs)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  mark(`← initialize ok: ${JSON.stringify(init.result?.agentInfo)} caps=${Object.keys(init.result?.agentCapabilities ?? {})}`)

  const session = await request('session/new', { cwd, mcpServers: [] })
  const options = session.result?.configOptions ?? []
  const model = options.find((o) => o.category === 'model')
  mark(`← session/new ${session.result?.sessionId} models=${model?.options?.length ?? 0} current=${model?.currentValue}`)

  const list = await request('session/list', { cwd })
  mark(`← session/list ${list.result?.sessions?.length ?? 0} sessions`)

  const close = await request('session/close', { sessionId: session.result?.sessionId })
  mark(`← session/close ${JSON.stringify(close.result ?? close.error)}`)
} catch (error) {
  console.log('PROBE ERROR:', error.message)
  if (stderr.trim().length > 0) console.log('stderr tail:', stderr.trim().split('\n').slice(-5).join(' / ').slice(0, 800))
} finally {
  child.kill('SIGKILL')
  process.exit(0)
}
