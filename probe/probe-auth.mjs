/**
 * Does the ACP server authenticate from `auth.json` instead of the environment?
 *
 * Writes a candidate auth document, spawns `opencode acp` with NO API key in
 * the environment, lists the model selector, and — only if a Go-plan model is
 * offered — runs one real turn.
 *
 * Usage: node probe-auth.mjs '<authJson>' [cwd]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const AUTH_PATH = '/root/.local/share/opencode/auth.json'
const auth = process.argv[2] ?? '{}'
const cwd = process.argv[3] ?? '/root'

if (auth === 'none') {
  rmSync(AUTH_PATH, { force: true })
  console.log('auth.json removed')
} else {
  mkdirSync('/root/.local/share/opencode', { recursive: true })
  writeFileSync(AUTH_PATH, auth, { mode: 0o600 })
  console.log('auth.json written:', auth.replace(/"key":"[^"]{6}[^"]*"/, '"key":"<redacted>"'))
}

const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' }
delete env.OPENCODE_API_KEY
delete env.OPENCODE_CONSOLE_TOKEN
// `env-auth` mode injects the same document through the environment instead of
// writing the user's global auth store.
if (auth.startsWith('env:')) {
  env.OPENCODE_AUTH_CONTENT = auth.slice('env:'.length)
  rmSync(AUTH_PATH, { force: true })
  console.log('auth.json removed; OPENCODE_AUTH_CONTENT set from argv')
}
console.log('OPENCODE_API_KEY in child env:', env.OPENCODE_API_KEY === undefined ? 'absent' : 'present')

const child = spawn('/usr/local/bin/opencode', ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
let nextId = 1
const pending = new Map()
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
    }
  }
})
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-1500) })

const request = (method, params, timeoutMs = 180_000) => {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const session = await request('session/new', { cwd, mcpServers: [] })
  const options = session.result?.configOptions ?? []
  const model = options.find((option) => option.category === 'model')
  const values = (model?.options ?? []).map((entry) => entry.value)
  const go = values.filter((value) => typeof value === 'string' && value.startsWith('opencode-go/'))
  console.log(`models: ${values.length}, go-plan: ${go.length}`)

  const target = values.find((value) => value === 'opencode-go/deepseek-v4.1-flash')
  if (target === undefined) {
    console.log('RESULT: no go-plan model offered; auth.json was not accepted as a Go credential')
  } else {
    const setModel = await request('session/set_config_option', {
      sessionId: session.result.sessionId, configId: model.id, value: target,
    })
    if (setModel.error !== undefined) console.log('set model error:', JSON.stringify(setModel.error))

    const prompt = await request('session/prompt', {
      sessionId: session.result.sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: OK' }],
    })
    if (prompt.error !== undefined) {
      console.log('RESULT: prompt failed →', JSON.stringify(prompt.error).slice(0, 300))
    } else {
      console.log('RESULT: prompt OK →', JSON.stringify(prompt.result))
    }
  }
} catch (error) {
  console.log('PROBE ERROR:', error.message)
  if (stderr.trim().length > 0) console.log('stderr:', stderr.trim().split('\n').slice(-4).join(' / ').slice(0, 500))
} finally {
  child.kill('SIGKILL')
  process.exit(0)
}
