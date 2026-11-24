import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpTransport } from '../lib/transport/acp.js'
import { CAPABILITY } from '../lib/transport/contract.js'
import { resolveAgent } from '../lib/config.js'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { SessionRegistry, SessionBinding } from '../lib/registry.js'
import { SessionAdmin } from '../lib/sessions.js'
import { ActivityStore, normalizeTool } from '../lib/activity.js'
import { redactText, redactArgs } from '../lib/redact.js'
import { scrubbedParentEnv } from '../lib/env.js'
import { LaunchDiagnostics } from '../lib/diagnostics.js'
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] })
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const answer = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
async function temporary(fn) { const dir = await mkdtemp(join(tmpdir(), 'agent-reliability-')); try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) } }
async function stubSession(request = async () => ({})) {
  const transport = new AcpTransport(resolveAgent('fixture', { command: 'fake', configWaitMs: 40 }), process.cwd())
  transport.capabilities.add(CAPABILITY.RESUME)
  const options = [{ id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }, { value: 'default' }] }]
  transport.agent = { request: async (method, params) => method === 'session/new' ? { sessionId: 'fixture', configOptions: options } : request(method, params), notify: async () => {} }
  transport.guard = async value => value
  transport.touch = () => {}
  transport.armIdleTimer = () => {}
  return { transport, session: await transport.create() }
}
test('typed boolean configuration uses the actual SDK wire schema', async () => temporary(async dir => {
  const profile = resolveAgent('a', { command: process.execPath, args: [AGENT], env: { FAKE_ACP_BOOLEAN: '1' } })
  const transport = await new AcpTransport(profile, dir).start()
  try { const session = await transport.create(); await session.setConfigOption('fast', true); assert.equal(session.configOptions.find(option => option.id === 'fast').currentValue, true) }
  finally { await transport.close() }
}))
test('model selection precedes dependent effort and mode on the real wire', async () => temporary(async dir => {
  const log = join(dir, 'config.jsonl')
  const profile = resolveAgent('a', { command: process.execPath, args: [AGENT], configOptions: { effort: 'high', mode: 'plan' }, env: { FAKE_ACP_CONFIG: log } })
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['a', profile]]), maxReplayChars: 100000 }), registry: new SessionRegistry(dir), resolveCwd: () => dir })
  try {
    await collect(adapter.stream({ provider: 'a', model: 'fake/sonnet', sessionId: 'c', messages: [user('test')] }))
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(calls[0].configId, 'model'); assert.equal(calls[0].value, 'fake/sonnet')
    assert.equal(calls[1].configId, 'effort'); assert.equal(calls[2].configId, 'mode')
  } finally { await adapter.dispose() }
}))
test('lazy ordinary option is applied after standard config_option_update and retained in state', async () => temporary(async dir => {
  const log = join(dir, 'config.jsonl')
  const profile = resolveAgent('a', { command: process.execPath, args: [AGENT], configOptions: { effort: 'high' }, env: { FAKE_ACP_CONFIG: log, FAKE_ACP_LAZY_EFFORT: '1' } })
  const activity = new ActivityStore(dir)
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['a', profile]]), maxReplayChars: 100000 }), activity, registry: new SessionRegistry(dir), resolveCwd: () => dir })
  try {
    await collect(adapter.stream({ provider: 'a', model: 'fake/sonnet', sessionId: 'c', messages: [user('test')] }))
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(calls.some(call => call.configId === 'effort' && call.value === 'high'))
    assert.equal((await activity.list('c'))[0].actualModel, 'fake/sonnet')
  } finally { await adapter.dispose() }
}))
test('direct configuration validation rejects bad values and preserves valid backend default', () => {
  for (const raw of [{ maxConcurrentTurns: 0 }, { maxConcurrentTurns: 17 }, { eventTimeoutMs: -1 }, { permission: 'unknown' }, { format: 'bad' }, { args: 'oops' }, { env: { KEY: 3 } }, { models: [{ id: 'a', maxTokens: -1 }] }]) {
    assert.throws(() => resolveAgent('a', { command: 'fake', ...raw }), /agents\.a\./)
  }
  assert.equal(resolveAgent('a', { command: 'fake', models: [{ id: 'default' }] }).models[0].id, 'default')
})
test('empty config ACK cannot synthesize an actual model', async () => {
  const { transport, session } = await stubSession()
  await assert.rejects(session.selectModel('b'), error => error.code === 'MODEL_UNCONFIRMED')
  assert.equal(session.selectedModel, 'a'); await transport.close()
})
test('delayed config notification confirms model without optimistic local mutation', async () => {
  let session
  const fixture = await stubSession(async () => { setTimeout(() => session.receiveConfig([{ ...session.configOptions[0], currentValue: 'b' }]), 10); return {} })
  session = fixture.session
  await session.selectModel('b'); assert.equal(session.selectedModel, 'b'); await fixture.transport.close()
})
test('backend default sentinel does not delete legitimate default id', async () => {
  const { transport, session } = await stubSession(async (_, params) => ({ configOptions: [{ ...session.configOptions[0], currentValue: params.value }] }))
  await session.selectModel('__dsh_backend_default__'); assert.equal(session.selectedModel, 'a')
  await session.selectModel('default'); assert.equal(session.selectedModel, 'default'); await transport.close()
})
test('safety options fail before prompt while ordinary missing options defer', async () => {
  const { transport, session } = await stubSession()
  await assert.rejects(session.applyConfig({ mode: 'plan' }), error => error.code === 'CONFIG_UNAVAILABLE')
  await session.applyConfig({ effort: 'high' }); assert.equal(session.deferredConfig.get('effort'), 'high'); await transport.close()
})
test('text CLI and unavailable host service never advertise image support', async () => temporary(async dir => {
  const profile = resolveAgent('a', { command: 'fake', transport: 'cli', format: 'text', cli: { promptVia: 'stdin' }, models: [{ id: 'a' }] })
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['a', profile]]) }), registry: new SessionRegistry(dir), resolveCwd: () => dir, readImage: async () => ({ data: new Uint8Array() }) })
  assert.deepEqual((await adapter.listModels('a'))[0].inputModalities, ['text'])
  await adapter.dispose()
}))
test('sanitizer covers JSON strings, tool titles, flags, bearer, basic URL auth and AUTH env', () => {
  const fake = 'FAKE_VALUE_NOT_A_SECRET'
  for (const text of [`{"api_key":"${fake}"}`, `api_key=${fake}`, `--token ${fake}`, `Bearer ${fake}`, `https://user:${fake}@example.invalid`]) assert.doesNotMatch(redactText(text), /FAKE_VALUE/)
  assert.doesNotMatch(normalizeTool({ title: `api_key=${fake}`, toolCallId: 'a' }).title, /FAKE_VALUE/)
  assert.deepEqual(redactArgs(['--token', fake]), ['--token', '[redacted]'])
  assert.equal(scrubbedParentEnv({ AUTHORIZATION: fake, HOME: '/home' }).AUTHORIZATION, undefined)
})
test('diagnostic rotation remains bounded and every line is valid sanitized JSON', async () => temporary(async dir => {
  const log = new LaunchDiagnostics(dir, { maxBytes: 1024 })
  await Promise.all(Array.from({ length: 24 }, (_, index) => log.record({ index, error: 'x'.repeat(100), args: ['--token', 'FAKE_VALUE_NOT_A_SECRET'] })))
  assert.ok((await stat(log.path)).size <= 1024)
  for (const path of [log.path, `${log.path}.1`]) {
    const text = await readFile(path, 'utf8'); assert.doesNotMatch(text, /FAKE_VALUE/)
    text.trim().split('\n').forEach(line => JSON.parse(line))
  }
}))
test('activity snapshots are detached and config events update actual model', async () => temporary(async dir => {
  const store = new ActivityStore(dir)
  const id = await store.begin({ dshSessionId: 'chat', route: 'a', cwd: dir })
  store.accept(id, { type: 'config', options: [], actualModel: 'b' })
  const snapshot = (await store.list('chat'))[0]
  snapshot.artifacts.push({ path: 'bad' }); snapshot.notices.push('bad')
  assert.equal((await store.list('chat'))[0].artifacts.length, 0)
  assert.equal((await store.list('chat'))[0].actualModel, 'b')
  await store.settle(id, 'completed')
}))
test('damaged stores degrade in memory without overwriting source or blocking new execution', async () => temporary(async dir => {
  await mkdir(join(dir, 'agent-providers')); await writeFile(join(dir, 'agent-providers', 'activity.json'), '{broken'); await writeFile(join(dir, 'agent-providers', 'sessions.json'), '{broken')
  const activity = new ActivityStore(dir); const id = await activity.begin({ dshSessionId: 'c', route: 'a', cwd: dir })
  await activity.settle(id, 'completed')
  assert.equal((await activity.list('c'))[0].status, 'completed')
  assert.ok(activity.persistenceError)
  assert.equal(await readFile(activity.path, 'utf8'), '{broken')
  const registry = new SessionRegistry(dir); assert.deepEqual(await registry.all(), [])
  await assert.rejects(registry.set('c', 'a', new SessionBinding({ externalSessionId: 'a' })))
}))
test('stale writer cannot overwrite another instance state', async () => temporary(async dir => {
  const first = new SessionRegistry(dir); const second = new SessionRegistry(dir)
  await first.load(); await second.load()
  await first.set('c', 'a', new SessionBinding({ externalSessionId: 'one' }))
  await assert.rejects(second.set('c', 'b', new SessionBinding({ externalSessionId: 'two' })), error => ['STATE_CONFLICT', 'STATE_BUSY'].includes(error.code))
  const disk = JSON.parse(await readFile(first.path)); assert.equal(disk.c.a.externalSessionId, 'one'); assert.equal(disk.c.b, undefined)
}))
test('saving failure cannot change completed execution into failed or rerun', async () => temporary(async dir => {
  const activity = new ActivityStore(dir); const id = await activity.begin({ dshSessionId: 'c', route: 'a', cwd: dir })
  let attempts = 0; activity.flush = async () => { attempts++; throw new Error('disk unavailable') }
  await activity.settle(id, 'completed'); await activity.settle(id, 'failed')
  assert.equal((await activity.list('c'))[0].status, 'completed'); assert.equal(attempts, 2); clearTimeout(activity.timer)
}))
test('admin operation holds same lock as prompts during async transport setup', async () => temporary(async dir => {
  const profile = resolveAgent('a', { command: 'fake' })
  const registry = new SessionRegistry(dir)
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['a', profile]]) }), registry, resolveCwd: () => dir })
  let releaseSetup
  const setup = new Promise(resolve => { releaseSetup = resolve })
  const admin = new SessionAdmin({ adapter, registry, current: adapter.current, resolveCwd: () => dir })
  let changed = false
  await registry.set('c', 'a', new SessionBinding({ externalSessionId: 'one', cwd: dir }))
  adapter.transportFor = async () => { await setup; return { kind: 'acp', capabilities: new Set([CAPABILITY.RESUME]), resume: async () => ({ selectedModel: 'a', configOptions: [{ id: 'mode', type: 'select', category: 'mode' }], capabilities: new Set([CAPABILITY.CONFIGURE]), setConfigOption: async () => { changed = true }, close: async () => {} }) } }
  const configuring = admin.configure({ route: 'a', dshSessionId: 'c', configId: 'mode', value: 'plan' })
  while (!adapter.isBusy('c', 'a')) await new Promise(resolve => setTimeout(resolve, 1))
  let acquired = false
  const next = adapter.lock('c', 'a').then(release => { acquired = true; release() })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(acquired, false)
  releaseSetup(); await configuring; await next; assert.equal(changed, true); await adapter.dispose()
}))
test('shared process Stop timeout settles all affected prompts as unknown, not just target', async () => temporary(async dir => {
  const profile = resolveAgent('a', { command: process.execPath, args: [AGENT], cancelTimeoutMs: 50, eventTimeoutMs: 10000, env: { FAKE_ACP_SILENCE_MS: '5000' } })
  const transport = await new AcpTransport(profile, dir).start()
  const first = await transport.create(); const second = await transport.create()
  const controller = new AbortController()
  const pending = Promise.allSettled([first.prompt({ text: 'one', signal: controller.signal }), second.prompt({ text: 'two' })])
  setTimeout(() => controller.abort(), 20)
  const outcomes = await pending
  assert.equal(outcomes[0].reason.executionUnknown, true); assert.equal(outcomes[1].reason.executionUnknown, true)
  assert.equal(outcomes[1].reason.code, 'PROCESS_INTERRUPTED'); await transport.close()
}))
test('account credential epoch changes create new process and prevent resume of old binding', async () => temporary(async dir => {
  let credential = 'FAKE_OLD_VALUE'
  const profile = resolveAgent('a', { command: process.execPath, args: [AGENT], credentials: { TEST_API_KEY: 'KEY' } })
  const registry = new SessionRegistry(dir)
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['a', profile]]), maxReplayChars: 100000 }), registry, resolveCwd: () => dir, credentials: { resolve: async () => credential } })
  try {
    const first = await collect(adapter.stream({ provider: 'a', model: 'fake/opus', sessionId: 'c', messages: [user('hello')] }))
    const old = await adapter.transportFor(profile, dir); const binding = await registry.get('c', 'a')
    credential = 'FAKE_NEW_VALUE'
    const fresh = await adapter.transportFor(profile, dir); let resumed = false
    fresh.resume = async () => { resumed = true; throw new Error('old account binding used') }
    await collect(adapter.stream({ provider: 'a', model: 'fake/opus', sessionId: 'c', messages: [user('hello'), assistant(answer(first)), user('next')] }))
    assert.notEqual(fresh.generation, binding.generation); assert.equal(old.closed, true); assert.equal(resumed, false)
  } finally { await adapter.dispose() }
}))
