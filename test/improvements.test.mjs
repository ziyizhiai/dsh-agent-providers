import assert from 'node:assert/strict'
import { test, after, before } from 'node:test'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { SessionBinding, SessionRegistry } from '../lib/registry.js'
import { resolveAgent } from '../lib/config.js'
import { ActivityStore, normalizeTool, safeValue } from '../lib/activity.js'
import { conversationWitness, continuityDecision, renderTranscript } from '../lib/render.js'
import { Semaphore } from '../lib/lifecycle.js'
import { translate } from '../lib/transport/acp.js'
import { SessionAdmin } from '../lib/sessions.js'
import { CliTransport } from '../lib/transport/cli.js'
import { handleState, handleAction } from '../lib/http.js'

let dir
const adapters = []
before(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-improvements-')) })
after(async () => { for (const adapter of adapters) await adapter.dispose(); await rm(dir, { recursive: true, force: true }) })
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
const collect = async stream => { const rows = []; for await (const row of stream) rows.push(row); return rows }
const text = rows => rows.filter(row => row.type === 'text-delta').map(row => row.text).join('')
function fixture(name, overrides = {}) {
  const profile = resolveAgent(name, { command: process.execPath, args: [fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))],
    models: [{ id: 'fake/opus' }], env: { FAKE_ACP_PROMPTS: join(dir, `${name}.jsonl`) }, ...overrides })
  const registry = new SessionRegistry(join(dir, name))
  const activity = new ActivityStore(join(dir, name))
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([[name, profile]]), maxReplayChars: 100000 }),
    registry, activity, resolveCwd: () => dir, credentials: { resolve: async () => undefined }, logger: { error() {} } })
  adapters.push(adapter)
  const turn = (messages, extra = {}) => collect(adapter.stream({ provider: name, model: 'fake/opus', sessionId: name, messages, ...extra }))
  return { profile, adapter, registry, activity, turn }
}
async function prompts(name) { return (await readFile(join(dir, `${name}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse) }

test('resume failure replays history into the newly created session', async () => {
  const { adapter, registry, turn } = fixture('restore')
  const first = await turn([user('remember BLUE')])
  const binding = await registry.get('restore', 'restore')
  const transport = await adapter.transportFor(adapter.current().profiles.get('restore'), dir)
  transport.resume = async () => { throw new Error('session missing') }
  await turn([user('remember BLUE'), assistant(text(first)), user('what color?')])
  const log = await prompts('restore')
  assert.notEqual(log[1].sessionId, binding.externalSessionId)
  assert.match(log[1].text, /remember BLUE/)
})

test('A-B-A handoff and assistant edits force full history replay', async () => {
  const { turn } = fixture('handoff')
  const first = await turn([user('first')])
  await turn([user('first'), assistant(text(first)), user('B task'), assistant('B modified important file'), user('back to A')])
  assert.match((await prompts('handoff'))[1].text, /B modified important file/)
  const witness = conversationWitness({ messages: [user('first')] }, text(first))
  assert.equal(continuityDecision({ messages: [user('first'), assistant('edited answer'), user('next')] }, witness).resume, false)
})

test('immediate next turn resumes when the actual answer is preserved', async () => {
  const { turn } = fixture('normal')
  const first = await turn([user('first')])
  await turn([user('first'), assistant(text(first)), user('second')])
  const log = await prompts('normal')
  assert.equal(log[0].sessionId, log[1].sessionId)
  assert.equal(log[1].text, 'second')
})

test('replay mode really replays and CLI model changes cannot silently resume', async () => {
  const { turn } = fixture('replay', { continuity: 'replay' })
  const first = await turn([user('first')]); await turn([user('first'), assistant(text(first)), user('second')])
  const log = await prompts('replay'); assert.notEqual(log[0].sessionId, log[1].sessionId)
})

test('model selection failure prevents the prompt from executing', async () => {
  const { turn } = fixture('model-reject')
  await assert.rejects(turn([user('must not run')], { model: 'not-an-option' }), /invalid value/)
  await assert.rejects(readFile(join(dir, 'model-reject.jsonl')), error => error.code === 'ENOENT')
})

test('binding and execution state are durable before finish is delivered', async () => {
  const { adapter, registry, activity } = fixture('finish')
  for await (const chunk of adapter.stream({ provider: 'finish', model: 'fake/opus', sessionId: 'finish', messages: [user('hi')] })) {
    if (chunk.type === 'finish') break
  }
  assert.ok((await registry.get('finish', 'finish')).sentMessageDigest)
  const disk = JSON.parse(await readFile(activity.path, 'utf8'))
  assert.equal(disk.runs[0].status, 'completed')
})

test('tools retain identity and patch title; plans retain status and support empty replacement', () => {
  const tools = new Map()
  const first = translate({ sessionUpdate: 'tool_call', toolCallId: 'one', title: 'Read file', status: 'in_progress', rawInput: { path: 'a' } }, tools)
  const completed = translate({ sessionUpdate: 'tool_call_update', toolCallId: 'one', status: 'completed', rawOutput: 'ok' }, tools)
  assert.equal(completed.title, first.title); assert.equal(completed.id, 'one'); assert.equal(completed.rawOutput, 'ok')
  assert.notEqual(normalizeTool({ toolCallId: 'two', title: 'Read file' }).id, first.id)
  assert.equal(translate({ sessionUpdate: 'plan', entries: [{ content: 'Test', status: 'completed', priority: 'high' }] }).entries[0].status, 'completed')
  assert.deepEqual(translate({ sessionUpdate: 'plan', entries: [] }).entries, [])
  assert.equal(translate({ sessionUpdate: 'config_option_update', configOptions: [] }).type, 'config')
})

test('activity persists tools but snapshots omit large bodies; restart settles open rows', async () => {
  const store = new ActivityStore(join(dir, 'store'))
  const id = await store.begin({ dshSessionId: 'chat', route: 'a', cwd: dir })
  store.update(id, { status: 'running' })
  store.accept(id, { type: 'tool', id: 'a', title: 'one', status: 'in_progress', rawOutput: 'body' })
  store.accept(id, { type: 'plan', entries: [{ id: 'p', content: 'Test', status: 'in_progress' }] })
  await store.flush()
  assert.equal((await store.list('chat'))[0].tools[0].rawOutput, undefined)
  assert.equal((await store.detail('chat', id, 'a')).output, 'body')
  const restored = new ActivityStore(join(dir, 'store'))
  const run = (await restored.list('chat'))[0]
  assert.equal(run.status, 'interrupted'); assert.equal(run.tools[0].status, 'interrupted'); assert.equal(run.plans[0].status, 'interrupted')
})

test('activity has bounded rows and sanitizes credential-shaped values', async () => {
  const store = new ActivityStore(join(dir, 'bounded'), { maxRuns: 2 })
  for (let i = 0; i < 4; i++) { const id = await store.begin({ dshSessionId: 'c', route: 'a', cwd: dir }); await store.settle(id, 'completed') }
  assert.equal((await store.list('c')).length, 2)
  assert.equal(safeValue({ apiKey: 'secret' }).apiKey, '[redacted]')
  assert.doesNotMatch(safeValue('Bearer abcdef'), /abcdef/)
})

test('artifact verification and preview reject outside paths, symlinks, and detect later changes', async () => {
  const cwd = join(dir, 'files'); await mkdir(cwd)
  await writeFile(join(cwd, 'result.txt'), 'original')
  await writeFile(join(dir, 'outside.txt'), 'outside')
  await symlink(join(dir, 'outside.txt'), join(cwd, 'link.txt'))
  const store = new ActivityStore(join(dir, 'artifacts'))
  const id = await store.begin({ dshSessionId: 'c', route: 'a', cwd })
  store.accept(id, { type: 'tool', id: 'edit', kind: 'edit', title: 'Edit', status: 'completed', locations: [{ path: 'result.txt' }, { path: '../outside.txt' }, { path: 'link.txt' }] })
  await store.verify(id)
  const run = (await store.list('c'))[0]
  assert.deepEqual(run.artifacts.map(a => a.status), ['verified', 'unavailable', 'unavailable'])
  await writeFile(join(cwd, 'result.txt'), 'changed')
  assert.equal((await store.preview('c', id, run.artifacts[0].id)).changedSinceVerified, true)
  await assert.rejects(store.preview('other', id, run.artifacts[0].id))
  await store.settle(id, 'completed')
})

test('cancelled semaphore wait never blocks later work', async () => {
  const semaphore = new Semaphore(1)
  const release = await semaphore.acquire()
  const controller = new AbortController()
  const pending = semaphore.acquire(controller.signal); controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  release(); const next = await semaphore.acquire(); next(); assert.equal(semaphore.active, 0)
})

test('oversized newest instructions fail honestly rather than being truncated', () => {
  assert.throws(() => renderTranscript({ system: 's'.repeat(500), messages: [user('latest')] }, 100), /exceed maxReplayChars/)
})

test('system changes invalidate a restored conversation', () => {
  const witness = conversationWitness({ system: 'old', messages: [user('hello')] }, 'answer')
  assert.equal(continuityDecision({ system: 'new', messages: [user('hello'), assistant('answer'), user('next')] }, witness).resume, false)
})

test('Stop settles a real ACP child within the configured acknowledgement bound', async () => {
  const { turn, adapter, activity, registry } = fixture('cancel', { eventTimeoutMs: 10000, cancelTimeoutMs: 100,
    env: { FAKE_ACP_SILENCE_MS: '10000' } })
  const controller = new AbortController()
  const pending = turn([user('stop me')], { signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 80)
  await assert.rejects(pending, error => error.name === 'AbortError')
  clearTimeout(timer)
  assert.equal(await registry.get('cancel', 'cancel'), undefined)
  assert.equal((await activity.list('cancel'))[0].status, 'cancelled')
  assert.equal(adapter.activeRuns.size, 0)
})

test('iterator return aborts provider work rather than leaving an orphan turn', async () => {
  const { adapter, activity } = fixture('return', { eventTimeoutMs: 10000, cancelTimeoutMs: 100,
    env: { FAKE_ACP_PACING_MS: '100', FAKE_ACP_PACING_STEPS: '20' } })
  for await (const chunk of adapter.stream({ provider: 'return', model: 'fake/opus', sessionId: 'return', messages: [user('stream')] })) {
    if (chunk.type === 'text-delta') break
  }
  assert.equal((await activity.list('return'))[0].status, 'interrupted')
})

test('session configuration is applied, persisted and reflected in the latest record', async () => {
  const f = fixture('configure')
  const first = await f.turn([user('hello')])
  const admin = new SessionAdmin({ adapter: f.adapter, registry: f.registry, current: f.adapter.current, resolveCwd: () => dir })
  await admin.configure({ dshSessionId: 'configure', route: 'configure', configId: 'mode', value: 'plan' })
  assert.equal((await f.registry.get('configure', 'configure')).sessionConfig.mode, 'plan')
  assert.equal((await f.activity.list('configure'))[0].configOptions.find(option => option.id === 'mode').currentValue, 'plan')
  await f.turn([user('hello'), assistant(text(first)), user('next')])
})

test('CLI silence watchdog kills a trapped child and pre-aborted prompts never spawn', async () => {
  const profile = resolveAgent('silent-cli', { transport: 'cli', command: process.execPath,
    args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], format: 'text',
    eventTimeoutMs: 80, cancelTimeoutMs: 80, cli: { promptVia: 'stdin' } })
  const transport = new CliTransport(profile, dir)
  const session = await transport.create()
  await assert.rejects(session.prompt({ text: 'hi' }), /silence deadline/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(session.prompt({ text: 'hi', signal: controller.signal }), error => error.name === 'AbortError')
  assert.equal(session.child, undefined)
  await transport.close()
})

test('state details require origin/header and scope to the current conversation', async () => {
  const activity = new ActivityStore(join(dir, 'http-state'))
  const id = await activity.begin({ dshSessionId: 'chat', route: 'a', cwd: dir }); await activity.settle(id, 'completed')
  const admin = { adapter: { activity } }
  const url = 'http://localhost/agent-providers/api/state?dshSessionId=chat'
  assert.equal((await handleState(admin, new Request(url))).status, 403)
  const response = await handleState(admin, new Request(url, { headers: { 'x-dsh-agent-providers': '1' } }))
  assert.equal((await response.json()).runs.length, 1)
  assert.equal((await handleAction({}, new Request('http://localhost/agent-providers/api/cancel?route=a&dshSessionId=', { headers: { 'x-dsh-agent-providers': '1' } }))).status, 400)
})
