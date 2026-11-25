import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ActivityStore } from '../lib/activity.js'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { SessionRegistry } from '../lib/registry.js'
import { SessionAdmin } from '../lib/sessions.js'
import { resolveAgent } from '../lib/config.js'
import { handleAction, handleState } from '../lib/http.js'
const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-recovery-'))
  const profile = resolveAgent('a', { command: process.execPath, args: [AGENT], env: { FAKE_ACP_PROMPTS: join(dir, 'prompts.jsonl') } })
  const registry = new SessionRegistry(dir); const activity = new ActivityStore(dir)
  const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['a', profile]]), maxReplayChars: 100000 }), registry, activity, resolveCwd: () => dir })
  const admin = new SessionAdmin({ adapter, registry, current: adapter.current, resolveCwd: () => dir })
  try { await fn({ dir, profile, registry, activity, adapter, admin }) }
  finally { await adapter.dispose(); clearTimeout(activity.timer); await activity.writes.catch(() => {}); await rm(dir, { recursive: true, force: true }) }
}
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
const drain = async stream => { for await (const _chunk of stream) {} }
async function unknown(activity, dir) {
  const id = await activity.begin({ dshSessionId: 'chat', route: 'a', cwd: dir })
  activity.accept(id, { type: 'tool', id: 'edit', kind: 'edit', status: 'in_progress', locations: [{ path: 'result.txt' }] })
  await activity.settle(id, 'unknown', { code: 'PROCESS_INTERRUPTED', message: 'process lost' })
  return id
}
test('unknown evidence inspection checks files only and never changes execution outcome', async () => fixture(async ({ dir, activity, admin }) => {
  await writeFile(join(dir, 'result.txt'), 'output')
  const id = await unknown(activity, dir)
  const result = await admin.inspect({ dshSessionId: 'chat', route: 'a', runId: id })
  assert.equal(result.review.evidence[0].state, 'exists'); assert.equal(result.executionStatus, 'unknown')
  await assert.rejects(readFile(join(dir, 'prompts.jsonl')), error => error.code === 'ENOENT')
  assert.equal((await activity.list('chat'))[0].tools[0].status, 'interrupted')
}))
test('acknowledgement requires inspection and does not claim success', async () => fixture(async ({ dir, activity, admin }) => {
  const id = await unknown(activity, dir)
  await assert.rejects(admin.acknowledge({ dshSessionId: 'chat', route: 'a', runId: id }), error => error.code === 'REVIEW_REQUIRED')
  await admin.inspect({ dshSessionId: 'chat', route: 'a', runId: id })
  const result = await admin.acknowledge({ dshSessionId: 'chat', route: 'a', runId: id })
  assert.equal(result.executionStatus, 'unknown'); assert.ok(result.review.acknowledgedAt)
  assert.equal(result.review.evidence[0].state, 'unavailable')
}))
test('unknown result gates next prompt until human review, then starts only explicitly new input', async () => fixture(async ({ dir, activity, adapter, admin }) => {
  const id = await unknown(activity, dir)
  const turn = () => drain(adapter.stream({ provider: 'a', model: 'fake/opus', sessionId: 'chat', messages: [user('NEW explicit instruction')] }))
  await assert.rejects(turn(), error => error.code === 'REVIEW_REQUIRED')
  await assert.rejects(readFile(join(dir, 'prompts.jsonl')))
  await admin.inspect({ dshSessionId: 'chat', route: 'a', runId: id }); await admin.acknowledge({ dshSessionId: 'chat', route: 'a', runId: id })
  await turn()
  const log = (await readFile(join(dir, 'prompts.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(log.length, 1); assert.match(log[0], /NEW explicit instruction/)
}))
test('review and acknowledgement survive restart; unreviewed unknown records cannot be pruned away', async () => fixture(async ({ dir, activity, admin }) => {
  activity.maxRuns = 2
  const id = await unknown(activity, dir)
  for (let i = 0; i < 4; i++) { const other = await activity.begin({ dshSessionId: 'other', route: 'a', cwd: dir }); await activity.settle(other, 'completed') }
  assert.ok(activity.runs.has(id))
  await admin.inspect({ dshSessionId: 'chat', route: 'a', runId: id }); await admin.acknowledge({ dshSessionId: 'chat', route: 'a', runId: id })
  const restarted = new ActivityStore(dir)
  assert.equal((await restarted.unresolved('chat', 'a')).length, 0)
  assert.ok((await restarted.list('chat'))[0].review.acknowledgedAt)
}))
test('inspection rejects another conversation and traversal/symlink evidence stays unavailable', async () => fixture(async ({ dir, activity, admin }) => {
  const cwd = join(dir, 'project'); await mkdir(cwd); await writeFile(join(dir, 'outside.txt'), 'outside'); await symlink(join(dir, 'outside.txt'), join(cwd, 'link.txt'))
  const id = await activity.begin({ dshSessionId: 'chat', route: 'a', cwd })
  activity.accept(id, { type: 'tool', id: 't', kind: 'edit', status: 'in_progress', locations: [{ path: '../outside.txt' }, { path: 'link.txt' }] })
  await activity.settle(id, 'unknown')
  await assert.rejects(admin.inspect({ dshSessionId: 'other', route: 'a', runId: id }), error => error.code === 'NOT_FOUND')
  const review = await admin.inspect({ dshSessionId: 'chat', route: 'a', runId: id })
  assert.deepEqual(review.review.evidence.map(entry => entry.state), ['unavailable', 'unavailable'])
}))
test('connection check creates no sessions and sends no prompt', async () => fixture(async ({ dir, admin, adapter, profile }) => {
  const result = await admin.connection({ dshSessionId: 'chat', route: 'a' })
  assert.equal(result.verified, 'protocol-handshake'); assert.equal(result.connected, true)
  assert.equal((await adapter.transportFor(profile, dir)).sessions.size, 0)
  await assert.rejects(readFile(join(dir, 'prompts.jsonl')))
}))
test('save retry reports persistence failure without execution and never overrides a conflicting writer', async () => fixture(async ({ dir, activity, registry, admin }) => {
  await activity.load(); await registry.load()
  await writeFile(activity.path, '{"version":1,"runs":[]}').catch(async () => { await mkdir(join(dir, 'agent-providers')); await writeFile(activity.path, '{"version":1,"runs":[]}') })
  const result = await admin.retryPersistence('chat')
  assert.equal(result.saved, false); assert.equal(result.reexecuted, false); assert.equal(result.activity.code, 'STATE_CONFLICT')
  await assert.rejects(readFile(join(dir, 'prompts.jsonl')))
}))
test('diagnostic export is conversation scoped and excludes raw tools, prompt and credentials', async () => fixture(async ({ dir, activity, admin }) => {
  const id = await activity.begin({ dshSessionId: 'chat', route: 'a', cwd: dir, title: 'PRIVATE_PROMPT' })
  activity.accept(id, { type: 'tool', id: 't', title: 'PRIVATE_TOOL_TITLE', status: 'completed', rawInput: 'PRIVATE_INPUT', rawOutput: 'PRIVATE_OUTPUT' })
  await activity.settle(id, 'completed', { message: 'api_key=FAKE_SECRET_VALUE' })
  const other = await activity.begin({ dshSessionId: 'other', route: 'a', cwd: dir }); await activity.settle(other, 'completed')
  const report = JSON.stringify(await admin.diagnosticReport('chat'))
  assert.doesNotMatch(report, /PRIVATE_|FAKE_SECRET_VALUE/)
  assert.equal(JSON.parse(report).runs.length, 1)
}))
test('new recovery and diagnostic endpoints enforce header and same-origin protection', async () => fixture(async ({ dir, activity, admin }) => {
  const id = await unknown(activity, dir)
  const query = `dshSessionId=chat&route=a&runId=${id}`
  for (const action of ['inspect', 'acknowledge', 'connection', 'retry-save']) {
    assert.equal((await handleAction(admin, new Request(`http://localhost/agent-providers/api/${action}?${query}`))).status, 403)
    assert.equal((await handleAction(admin, new Request(`http://localhost/agent-providers/api/${action}?${query}`, { headers: { 'x-dsh-agent-providers': '1', origin: 'https://evil.invalid' } }))).status, 403)
  }
  const url = 'http://localhost/agent-providers/api/state?dshSessionId=chat&diagnostics=1'
  assert.equal((await handleState(admin, new Request(url))).status, 403)
  const report = await handleState(admin, new Request(url, { headers: { 'x-dsh-agent-providers': '1' } }))
  assert.equal((await report.json()).runs.length, 1)
}))
