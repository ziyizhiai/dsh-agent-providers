/**
 * End-to-end tests for the adapter, driven by real ACP and CLI agents over
 * stdio. No external agent CLI is required.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { resolveAgent } from '../lib/config.js'
import { SessionRegistry } from '../lib/registry.js'

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
const CLI = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))
let seq = 0
/** Each test gets its own DSH Session so bindings never leak across tests. */
const newSession = () => `session-test-${++seq}`

let dir
let prompts
const built = []

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-agent-providers-'))
  prompts = join(dir, 'prompts.jsonl')
})

after(async () => {
  for (const adapter of built) await adapter.dispose()
  await rm(dir, { recursive: true, force: true })
})

/** Build one adapter over a single route named `fake`. */
function makeAdapter(raw = {}, extra = {}) {
  const profile = resolveAgent('fake', {
    displayName: 'Fake Agent',
    command: process.execPath,
    args: [AGENT],
    permission: 'allow',
    continuity: 'auto',
    idleReleaseMs: 60_000,
    ...raw,
  })
  const registry = new SessionRegistry(dir)
  const adapter = new AgentProviderAdapter({
    current: () => ({ profiles: new Map([['fake', profile]]), maxReplayChars: 100_000 }),
    registry,
    resolveCwd: () => dir,
    credentials: { resolve: async () => ({ value: 'test-secret' }) },
    ...(extra.readImage === undefined ? {} : { readImage: extra.readImage }),
    logger: { error: () => {} },
  })
  built.push(adapter)
  return { adapter, registry, profile, sid: newSession() }
}

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const texts = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

async function turn(adapter, sid, messages, extra = {}) {
  return collect(adapter.stream({ provider: 'fake', model: 'fake/opus', sessionId: sid, messages, ...extra }))
}

async function promptLog() {
  return (await readFile(prompts, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('lists statically declared models without spawning the agent', async () => {
  const { adapter, sid } = makeAdapter({
    models: [
      { id: 'fake/opus', name: 'Fake Opus', contextWindow: 100_000, maxTokens: 8_000 },
      { id: 'fake/sonnet', name: 'Fake Sonnet' },
    ],
  })
  const models = await adapter.listModels('fake')
  assert.deepEqual(models.map((model) => model.id), ['fake/opus', 'fake/sonnet'])
  assert.equal(models[0].provider, 'fake')
  const resolved = await adapter.resolveModel('fake', 'fake/opus')
  assert.equal(resolved.context.contextWindow, 100_000)
  assert.equal(resolved.defaultMaxTokens, 8_000)
  assert.equal((await adapter.resolveModel('fake', 'unknown')).context.contextWindow, 200_000,
    'without a declaration or a route default the neutral fallback applies')
})

test('the route default window applies to every model it serves', async () => {
  const { adapter } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    defaultContextWindow: 1_000_000,
    defaultMaxTokens: 32_000,
  })
  const declared = await adapter.resolveModel('fake', 'fake/opus')
  assert.equal(declared.context.contextWindow, 1_000_000, 'declared models inherit the route default')
  assert.equal(declared.defaultMaxTokens, 32_000)
  const probed = await adapter.resolveModel('fake', 'fake/haiku')
  assert.equal(probed.context.contextWindow, 1_000_000, 'probe-only models get it too')
})

test('catalog: probe keeps the agent catalogue and applies declared overrides', async () => {
  const { adapter } = makeAdapter({
    catalog: 'probe',
    models: [
      { id: 'fake/opus', name: 'Opus (pinned)', contextWindow: 262_144 },
      { id: 'fake/extra', name: 'Not advertised' },
    ],
  })
  const models = await adapter.listModels('fake')
  assert.deepEqual(models.map((model) => model.id), ['fake/opus', 'fake/sonnet', 'fake/haiku', 'fake/extra'],
    'the agent catalogue survives, with an unadvertised declared model appended')
  assert.equal(models[0].name, 'Opus (pinned)', 'a declared name overrides the advertised one')
  assert.equal((await adapter.resolveModel('fake', 'fake/opus')).context.contextWindow, 262_144,
    'the pinned window wins over the route default')
  assert.equal((await adapter.resolveModel('fake', 'fake/sonnet')).context.contextWindow, 200_000)
})

test('catalog: declared never asks the agent', async () => {
  const { adapter } = makeAdapter({
    catalog: 'declared',
    models: [{ id: 'only', name: 'Only', contextWindow: 8_000 }],
    command: '/nonexistent/agent',
  })
  const models = await adapter.listModels('fake')
  assert.deepEqual(models.map((model) => model.id), ['only'], 'no spawn, so a bad command cannot break the picker')
})

test('a declared per-model window beats the route default', async () => {
  const { adapter } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus', contextWindow: 262_144 }],
    defaultContextWindow: 1_000_000,
  })
  assert.equal((await adapter.resolveModel('fake', 'fake/opus')).context.contextWindow, 262_144)
  assert.equal((await adapter.resolveModel('fake', 'fake/sonnet')).context.contextWindow, 1_000_000)
})

test('a window the agent reports for itself overrides the route default', async () => {
  const { adapter } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    defaultContextWindow: 200_000,
  })
  assert.equal((await adapter.resolveModel('fake', 'fake/opus')).context.contextWindow, 200_000)
  await turn(adapter, 'session-window-1', [user('report your window')])
  assert.equal(
    (await adapter.resolveModel('fake', 'fake/opus')).context.contextWindow,
    1_000_000,
    'the agent measured 1M and that now outranks the default',
  )
})

test('probes the agent for its catalogue and caches it', async () => {
  const { adapter, sid } = makeAdapter({ models: [] })
  const first = await adapter.listModels('fake')
  assert.deepEqual(first.map((model) => model.id), ['fake/opus', 'fake/sonnet', 'fake/haiku'])
  assert.deepEqual(first[0].inputModalities, ['text'],
    'image input is only advertised when this composition can actually read the bytes')
  assert.deepEqual(first[0].badge, { text: 'Agent', tone: 'info' },
    'every agent-backed model carries a selector badge')
  const second = await adapter.listModels('fake')
  assert.deepEqual(second, first, 'the second read is served from cache')
})

test('one turn yields a well-formed assistant message', async () => {
  process.env.FAKE_ACP_PROMPTS = prompts
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }] })
  const chunks = await turn(adapter, sid, [user('hello world')])

  assert.equal(chunks.some((chunk) => chunk.type === 'tool-call-delta'), false)

  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  const ends = chunks.filter((chunk) => chunk.type === 'block-end')
  assert.equal(starts.length, ends.length)
  assert.deepEqual(starts.map((chunk) => chunk.blockType).sort(), ['reasoning', 'text'])
  for (const start of starts) {
    const end = ends.find((chunk) => chunk.index === start.index)
    assert.notEqual(end, undefined, `block ${start.index} was never closed`)
    assert.equal(end.block.type, start.blockType)
  }

  assert.match(texts(chunks), /hello world/)

  const reasoning = ends.find((chunk) => chunk.block.type === 'reasoning').block.text
  assert.match(reasoning, /thinking…/)
  assert.match(reasoning, /→ Read src\/app\.ts/)
  assert.match(reasoning, /◻ inspect the module/)

  const usage = chunks.find((chunk) => chunk.type === 'usage')
  // Measured against the real agent: `inputTokens` already excludes the cached
  // portion, so it is passed through rather than adjusted.
  assert.equal(usage.usage.inputTokens, 120)
  assert.equal(usage.usage.cacheReadTokens, 20)
  assert.equal(usage.usage.outputTokens, 7)
  assert.equal(usage.usage.reasoningTokens, 3)
  assert.equal(usage.usage.totalTokens, undefined, 'no invented total; the harness derives it')

  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  delete process.env.FAKE_ACP_PROMPTS
})

test('images from the current turn reach an agent that accepts them', async () => {
  process.env.FAKE_ACP_PROMPTS = prompts
  try {
    const { adapter, sid } = makeAdapter(
      { models: [{ id: 'fake/opus', name: 'Fake Opus' }] },
      { readImage: async () => ({ data: new Uint8Array([1, 2, 3, 4]) }) },
    )
    const models = await adapter.listModels('fake')
    assert.deepEqual(models[0].inputModalities, ['text', 'image'], 'a real reader upgrades the advertised modality')

    await rm(prompts, { force: true })
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this screenshot?' },
        { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      ],
    }]
    await turn(adapter, sid, messages)
    const logged = await promptLog()
    assert.equal(logged[0].images, 1, 'the attachment is forwarded as an image block')
  } finally {
    delete process.env.FAKE_ACP_PROMPTS
  }
})

test('a cold start announces itself and still assembles cleanly', async () => {
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }] })
  const chunks = await turn(adapter, sid, [user('hello')])
  assert.match(chunks.find((chunk) => chunk.type === 'reasoning-delta' && chunk.index === 0).text,
    /Starting Fake Agent…/)

  // The harness's own assembler must accept the stream: an unclosed block or a
  // stray delta would be caught here rather than in the browser.
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.deepEqual(blocks.map((block) => block.type).sort(), ['reasoning', 'text'])
  assert.deepEqual(assembler.finish, { kind: 'stop' })
  assert.equal(assembler.usage.inputTokens, 120)
})

test('a warm turn does not repeat the start notice', async () => {
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }], continuity: 'resume' })
  await turn(adapter, sid, [user('one')])
  const second = await turn(adapter, sid, [user('one'), { role: 'assistant', content: [{ type: 'text', text: 'x' }] }, user('two')])
  assert.equal(second.some((chunk) => chunk.type === 'reasoning-delta' && /Starting/.test(chunk.text)), false)
})

test('a second turn resumes the same conversation and sends only the delta', async () => {
  process.env.FAKE_ACP_PROMPTS = prompts
  const { adapter, registry, sid } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    continuity: 'resume',
  })
  const first = [user('first question')]
  await turn(adapter, sid, first)

  const binding = await registry.get(sid, 'fake')
  assert.equal(binding.externalSessionId, 'fake-session-1')
  assert.equal(binding.sentUserCount, 1)

  await rm(prompts, { force: true })
  const second = [...first, assistant('first answer'), user('second question')]
  const chunks = await turn(adapter, sid, second)

  const logged = await promptLog()
  assert.equal(logged.length, 1)
  assert.equal(logged[0].sessionId, 'fake-session-1', 'the turn reuses the loaded session')
  assert.equal(logged[0].text, 'second question', 'only the new user input is forwarded')
  assert.doesNotMatch(texts(chunks), /\[replayed\]/, 'load-time replay must not reach the harness message')
  delete process.env.FAKE_ACP_PROMPTS
})

test('a plan-denied model keeps its place but gains a warning badge', async () => {
  process.env.FAKE_ACP_DENY = '1'
  try {
    const { adapter, sid } = makeAdapter({ models: [] })
    await assert.rejects(turn(adapter, sid, [user('hello')]), /Model access is disabled/)
    const models = await adapter.listModels('fake')
    // The catalogue is the agent's; we do not hide what it advertises.
    assert.equal(models.length, 3)
    assert.deepEqual(models[0].badge, { text: { en: 'no access', zh: '无权限' }, tone: 'warning' },
      'the picker now says why the model will not answer')
  } finally {
    delete process.env.FAKE_ACP_DENY
  }

  // A model that answers clears the mark.
  const { adapter, sid } = makeAdapter({ models: [] })
  await turn(adapter, newSession(), [user('hello')])
  const after = await adapter.listModels('fake')
  assert.deepEqual(after[0].badge, { text: 'Agent', tone: 'info' })
})

test('the badge is configurable per route', async () => {
  const { adapter } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    badgeText: '外部',
    badgeTone: 'warning',
  })
  const models = await adapter.listModels('fake')
  assert.deepEqual(models[0].badge, { text: '外部', tone: 'warning' })
})

test('a changed model is applied through the session config option', async () => {
  process.env.FAKE_ACP_PROMPTS = prompts
  const { adapter, sid } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus' }, { id: 'fake/sonnet', name: 'Fake Sonnet' }],
    continuity: 'resume',
  })
  await turn(adapter, sid, [user('a')])
  await rm(prompts, { force: true })
  await collect(adapter.stream({
    provider: 'fake',
    model: 'fake/sonnet',
    sessionId: sid,
    messages: [user('a'), assistant('x'), user('b')],
  }))
  const logged = await promptLog()
  assert.equal(logged[0].model, 'fake/sonnet')
  delete process.env.FAKE_ACP_PROMPTS
})

test('compacted history falls back to a full replay instead of resuming', async () => {
  process.env.FAKE_ACP_PROMPTS = prompts
  const { adapter, registry, sid } = makeAdapter({
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    continuity: 'resume',
  })
  await turn(adapter, sid, [user('original'), assistant('answer')])
  const before = await registry.get(sid, 'fake')

  await rm(prompts, { force: true })
  await turn(adapter, sid, [user('original but summarized'), assistant('answer'), user('next')])
  const logged = await promptLog()
  assert.match(logged[0].text, /# Conversation/, 'a replay carries the whole transcript')
  const afterBinding = await registry.get(sid, 'fake')
  assert.notEqual(afterBinding.externalSessionId, before.externalSessionId)
  delete process.env.FAKE_ACP_PROMPTS
})

test('an agent without loadSession replays every turn', async () => {
  process.env.FAKE_ACP_PROMPTS = prompts
  process.env.FAKE_ACP_NO_LOAD = '1'
  try {
    const { adapter, registry, sid } = makeAdapter({
      models: [{ id: 'fake/opus', name: 'Fake Opus' }],
      continuity: 'auto',
    })
    await turn(adapter, sid, [user('one')])
    await turn(adapter, sid, [user('one'), assistant('reply'), user('two')])
    assert.equal(await registry.get(sid, 'fake'), undefined, 'a transport without RESUME keeps no binding')
  } finally {
    delete process.env.FAKE_ACP_NO_LOAD
    delete process.env.FAKE_ACP_PROMPTS
  }
})

test('a CLI transport works through the same adapter', async () => {
  process.env.FAKE_CLI_PROMPTS = prompts
  try {
    const { adapter, registry, sid } = makeAdapter({
      transport: 'cli',
      format: 'jsonl',
      command: process.execPath,
      args: [CLI],
      models: [{ id: 'deep', name: 'Deep' }],
      cli: {
        promptVia: 'stdin',
        resumeArgs: ['--resume', '{session}'],
        sessionIdPath: 'session_id',
        modelArgs: ['--model', '{model}'],
        jsonl: {
          text: 'message.content',
          reasoning: 'message.reasoning',
          tool: 'message.tool',
          usage: { input: 'usage.input_tokens', output: 'usage.output_tokens' },
        },
      },
    })
    const first = await collect(adapter.stream({
      provider: 'fake', model: 'deep', sessionId: sid, messages: [user('hello cli')],
    }))
    assert.match(texts(first), /hello cli/)
    assert.match(texts(first), /done\(deep\)/)
    assert.deepEqual(first.at(-1).reason, { kind: 'stop' })

    const binding = await registry.get(sid, 'fake')
    assert.match(binding.externalSessionId, /^ses-/)

    await rm(prompts, { force: true })
    const second = await collect(adapter.stream({
      provider: 'fake', model: 'deep', sessionId: sid,
      messages: [user('hello cli'), assistant('reply'), user('second')],
    }))
    assert.match(texts(second), /second/)
    const logged = await promptLog()
    assert.equal(logged[0].sessionId, binding.externalSessionId, 'the CLI is resumed with the stored id')
  } finally {
    delete process.env.FAKE_CLI_PROMPTS
  }
})

test('a title request is answered locally instead of spending an agent run', async () => {
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }] })
  const chunks = await collect(adapter.stream({
    provider: 'fake', model: 'fake/opus', sessionId: sid,
    messages: [user('请帮我看看这个仓库的构建脚本为什么失败\n第二行细节')],
    purpose: 'session-title',
  }))
  assert.equal(texts(chunks), '请帮我看看这个仓库的构建脚本为什么失败')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('any other auxiliary purpose is refused rather than faked', async () => {
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }] })
  await assert.rejects(
    collect(adapter.stream({
      provider: 'fake', model: 'fake/opus', sessionId: sid,
      messages: [user('summarize this')], purpose: 'compaction',
    })),
    /cannot serve the auxiliary purpose "compaction"/,
  )
})

test('an unknown provider route is reported, not silently ignored', async () => {
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }] })
  await assert.rejects(
    collect(adapter.stream({ provider: 'nope', model: 'x', messages: [user('hi')] })),
    /no agent backend is configured/,
  )
})

test('concurrent turns on one session are serialized', async () => {
  const { adapter, sid } = makeAdapter({ models: [{ id: 'fake/opus', name: 'Fake Opus' }] })
  const [first, second] = await Promise.all([
    turn(adapter, sid, [user('one')]),
    turn(adapter, sid, [user('two')]),
  ])
  assert.match(texts(first), /one/)
  assert.match(texts(second), /two/)
})

test('a missing credential names the reference instead of leaking or guessing', async () => {
  const profile = resolveAgent('fake', {
    command: process.execPath,
    args: [CLI],
    transport: 'cli',
    format: 'jsonl',
    credentials: { OPENCODE_API_KEY: 'SOME_MISSING_REF' },
    cli: { promptVia: 'stdin', jsonl: { text: 'message.content' } },
  })
  const adapter = new AgentProviderAdapter({
    current: () => ({ profiles: new Map([['fake', profile]]), maxReplayChars: 10_000 }),
    registry: new SessionRegistry(dir),
    resolveCwd: () => dir,
    credentials: { resolve: async () => undefined },
    logger: { error: () => {} },
  })
  built.push(adapter)
  await assert.rejects(
    turn(adapter, newSession(), [user('x')]),
    /needs credential "SOME_MISSING_REF"/,
  )
})
