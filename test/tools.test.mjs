/** The model-facing `agent_sessions` tool. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { resolveAgent } from '../lib/config.js'
import { SessionRegistry } from '../lib/registry.js'
import { SessionAdmin } from '../lib/sessions.js'
import { TOOL_NAME, registerTool } from '../lib/tools.js'

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))

let dir
const built = []

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-'))
})

after(async () => {
  for (const { adapter } of built) await adapter.dispose()
  await rm(dir, { recursive: true, force: true })
})

/** Build the real admin plus the registered tool definition. */
function makeTool(overrides = {}) {
  const profile = resolveAgent('fake', {
    displayName: 'Fake Agent',
    command: process.execPath,
    args: [AGENT],
    idleReleaseMs: 60_000,
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    ...overrides,
  })
  const profiles = new Map([['fake', profile]])
  const registry = new SessionRegistry(dir)
  const adapter = new AgentProviderAdapter({
    current: () => ({ profiles, maxReplayChars: 100_000 }),
    registry,
    resolveCwd: () => dir,
    credentials: { resolve: async () => ({ value: 'secret' }) },
    logger: { error: () => {} },
  })
  const admin = new SessionAdmin({
    adapter,
    current: () => ({ profiles }),
    registry,
    resolveCwd: () => dir,
    logger: { error: () => {} },
  })
  let definition
  const ctx = { tools: { register(value) { definition = value; return () => {} } } }
  registerTool(ctx, admin)
  built.push({ adapter })
  return { adapter, admin, registry, definition }
}

/** A stand-in for the tool execution context. */
function exec(sessionId = 'session-tool-1', provider = 'fake') {
  return {
    agent: {
      session: { id: sessionId },
      model: { current: () => ({ provider, model: 'fake/opus' }) },
    },
  }
}

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

async function seed(adapter, sid, text = 'hello') {
  for await (const _chunk of adapter.stream({
    provider: 'fake', model: 'fake/opus', sessionId: sid, messages: [user(text)],
  })) {
    // drain
  }
}

test('registers under the stable tool name', () => {
  const { definition } = makeTool()
  assert.equal(definition.name, TOOL_NAME)
  assert.equal(typeof definition.execute, 'function')
  assert.deepEqual(definition.parameters.properties.action.enum, ['list', 'fork', 'close'])
  assert.deepEqual(definition.parameters.required, ['action'])
})

test('list reports the route inventory', async () => {
  const { adapter, definition } = makeTool()
  await seed(adapter, 'session-tool-list')
  const result = await definition.execute({ action: 'list' }, exec('session-tool-list'))
  assert.match(result.summary, /^fake \(Fake Agent\) — 1 session\(s\)/)
  assert.match(result.summary, /fake-session-1/)
  assert.match(result.summary, /bound to session-tool-list/)
})

test('fork branches the current conversation and says so', async () => {
  const { adapter, definition, registry } = makeTool()
  const sid = 'session-tool-fork'
  await seed(adapter, sid)
  const before = await registry.get(sid, 'fake')

  const result = await definition.execute({ action: 'fork' }, exec(sid))
  assert.match(result.summary, /Forked the agent conversation/)
  const afterBinding = await registry.get(sid, 'fake')
  assert.notEqual(afterBinding.externalSessionId, before.externalSessionId)
  assert.match(result.summary, new RegExp(afterBinding.externalSessionId))
})

test('close releases the session bound to this conversation', async () => {
  const { adapter, definition, registry } = makeTool()
  const sid = 'session-tool-close'
  await seed(adapter, sid)
  const binding = await registry.get(sid, 'fake')

  const result = await definition.execute({ action: 'close' }, exec(sid))
  assert.match(result.summary, new RegExp(binding.externalSessionId))
  assert.equal(await registry.get(sid, 'fake'), undefined)
})

test('a Session driven by a plain model provider is told so', async () => {
  const { definition } = makeTool()
  await assert.rejects(
    definition.execute({ action: 'fork' }, exec('s', 'opencode')),
    /not an agent route/,
  )
})

test('an unknown action is rejected before it can reach any backend', async () => {
  const { definition } = makeTool()
  // The tool's own argument schema rejects it, which is stronger than a
  // runtime switch: the model sees the allowed values in the schema.
  await assert.rejects(
    definition.execute({ action: 'explode' }, exec()),
    /"action" must be one of \["list","fork","close"\]/,
  )
})

test('closing someone else\'s conversation needs an explicit session id', async () => {
  const { definition } = makeTool()
  await assert.rejects(
    definition.execute({ action: 'close', route: 'other' }, exec()),
    /not "other"; name the sessionId explicitly/,
  )
})
