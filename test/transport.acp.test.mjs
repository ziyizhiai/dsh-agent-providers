/** Conformance for the ACP transport, driven by a real ACP agent over stdio. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from '../lib/config.js'
import { CAPABILITY, STOP_REASON } from '../lib/transport/contract.js'
import { AcpTransport } from '../lib/transport/acp.js'
import { createTransport } from '../lib/transport/index.js'
import { runTransportConformance } from './conformance.mjs'

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
const profile = resolveAgent('fake', {
  displayName: 'Fake Agent',
  command: process.execPath,
  args: [AGENT],
})

/** The same fake agent with extra profile fields. */
const fakeAgent = (overrides = {}) => resolveAgent('fake', {
  displayName: 'Fake Agent',
  command: process.execPath,
  args: [AGENT],
  ...overrides,
})
const cwd = fileURLToPath(new URL('.', import.meta.url))
const tmp = cwd
const configLog = join(tmpdir(), `dsh-fake-acp-config-${process.pid}.jsonl`)

/** Read what the fake agent recorded for applied session configuration. */
async function readConfigLog() {
  try {
    return readFileSync(configLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const transports = []

before(() => {})

after(async () => {
  for (const transport of transports) await transport.close()
})

async function open(overrides = {}, options = {}) {
  const transport = new AcpTransport({ ...profile, ...overrides }, cwd, options)
  transports.push(transport)
  await transport.start()
  return transport
}

test('signs in when the agent demands it, using the profile parameters', async () => {
  process.env.FAKE_ACP_AUTH = '1'
  try {
    const profile = fakeAgent({
      auth: {
        methodId: 'api-key',
        ref: 'FAKE_KEY',
        params: { _meta: { 'api-key': { apiKey: '{value}' } } },
      },
    })
    const transport = await createTransport(profile, {
      cwd: tmp,
      credentials: { resolve: async () => 'secret-value' },
      resolveExecutable: async (command) => command,
    })
    assert.deepEqual(transport.authMethods, ['api-key'], 'the advertised methods are reported')
    const session = await transport.create()
    assert.ok(session.externalId.startsWith('fake-session'), 'session/new succeeded only after authenticate')
    await transport.close()
  } finally {
    delete process.env.FAKE_ACP_AUTH
  }
})

test('a required sign-in with no stored credential names the missing ref', async () => {
  process.env.FAKE_ACP_AUTH = '1'
  try {
    const profile = fakeAgent({
      auth: { methodId: 'api-key', ref: 'FAKE_KEY', params: {} },
    })
    await assert.rejects(
      createTransport(profile, {
        cwd: tmp,
        credentials: { resolve: async () => undefined },
        resolveExecutable: async (command) => command,
      }),
      /needs credential "FAKE_KEY" to sign in/,
    )
  } finally {
    delete process.env.FAKE_ACP_AUTH
  }
})

test('an agent offering a different method is not signed in with ours', async () => {
  // The agent advertises `fake-login` here, so a configured `api-key` block must
  // stay unused rather than being sent to a method the agent never offered.
  const profile = fakeAgent({
    auth: { methodId: 'api-key', ref: 'FAKE_KEY', params: {} },
  })
  const transport = await createTransport(profile, {
    cwd: tmp,
    credentials: { resolve: async () => 'unused' },
    resolveExecutable: async (command) => command,
  })
  assert.deepEqual(transport.authMethods, ['fake-login'])
  const session = await transport.create()
  assert.ok(session.externalId.length > 0, 'the session is created without a sign-in call')
  await transport.close()
})

test('profile session configuration is applied by option id', async () => {
  process.env.FAKE_ACP_CONFIG = configLog
  try {
    const profile = fakeAgent({
      configOptions: { model: 'fake/sonnet', effort: 'high', mode: 'plan' },
    })
    const transport = await createTransport(profile, {
      cwd: tmp,
      credentials: { resolve: async () => 'test-secret' },
      resolveExecutable: async (command) => command,
    })
    await rm(configLog, { force: true })
    await transport.create()
    const calls = await readConfigLog()
    assert.deepEqual(
      calls.filter((call) => call.method === 'session/set_config_option').map((call) => `${call.configId}=${call.value}`).sort(),
      ['effort=high', 'mode=plan', 'model=fake/sonnet'],
      'every published option is applied',
    )
    assert.equal(calls.some((call) => call.method === 'session/set_mode'), false, 'a published config option is used instead')
    await transport.close()
  } finally {
    delete process.env.FAKE_ACP_CONFIG
  }
})

test('a mode published only as legacy modes goes through session/set_mode', async () => {
  process.env.FAKE_ACP_CONFIG = configLog
  process.env.FAKE_ACP_LEGACY_MODE = '1'
  try {
    const profile = fakeAgent({
      configOptions: { mode: 'plan' },
    })
    const transport = await createTransport(profile, {
      cwd: tmp,
      credentials: { resolve: async () => 'test-secret' },
      resolveExecutable: async (command) => command,
    })
    await rm(configLog, { force: true })
    await transport.create()
    const calls = await readConfigLog()
    assert.deepEqual(calls.map((call) => call.method), ['session/set_mode'])
    assert.equal(calls[0].modeId, 'plan')
    await transport.close()
  } finally {
    delete process.env.FAKE_ACP_CONFIG
    delete process.env.FAKE_ACP_LEGACY_MODE
  }
})

test('an unknown session option is skipped, not fatal', async () => {
  const profile = fakeAgent({ configOptions: { nonexistent: 'x' } })
  const transport = await createTransport(profile, {
    cwd: tmp,
    credentials: { resolve: async () => 'test-secret' },
    resolveExecutable: async (command) => command,
  })
  const session = await transport.create()
  assert.ok(session.externalId.length > 0, 'the session stays usable')
  await transport.close()
})

test('satisfies the transport contract', async (t) => {
  await runTransportConformance({ ...t, cwd }, {
    makeTransport: () => open(),
    capabilities: { resume: true, list: true },
  })
})

test('reads capabilities from the agent, not from a guess', async () => {
  const transport = await open()
  assert.equal(transport.capabilities.has(CAPABILITY.RESUME), true)
  assert.equal(transport.capabilities.has(CAPABILITY.LIST), true)
  assert.equal(transport.capabilities.has(CAPABILITY.FORK), true)
  assert.equal(transport.capabilities.has(CAPABILITY.SWITCH_MODEL), false)
  const session = await transport.create()
  assert.equal(session.capabilities.has(CAPABILITY.SWITCH_MODEL), true)
  assert.equal(transport.capabilities.has(CAPABILITY.IMAGES), true)
})

test('a one-shot agent advertises no RESUME', async () => {
  process.env.FAKE_ACP_NO_LOAD = '1'
  try {
    const transport = await open()
    assert.equal(transport.capabilities.has(CAPABILITY.RESUME), false)
    await assert.rejects(transport.resume('whatever'), /load|failed/i)
  } finally {
    delete process.env.FAKE_ACP_NO_LOAD
  }
})

test('the catalogue comes from the agent model selector', async () => {
  const transport = await open()
  const models = await transport.catalog({ cwd })
  assert.deepEqual(models.map((model) => model.id), ['fake/opus', 'fake/sonnet', 'fake/haiku'])
  assert.equal(models[0].name, 'Fake Opus')
})

test('one process serves several sessions', async () => {
  const transport = await open()
  const first = await transport.create({ cwd })
  const second = await transport.create({ cwd })
  assert.notEqual(first.externalId, second.externalId)
  await first.prompt({ text: 'one' })
  await second.prompt({ text: 'two' })
  assert.ok(transport.sessions.size >= 2)
})

test('a resumed session reports that it resumed', async () => {
  const transport = await open()
  const created = await transport.create({ cwd })
  await created.prompt({ text: 'record something' })
  const id = created.externalId
  await created.close()

  const resumed = await transport.resume(id, { cwd })
  assert.equal(resumed.resumed, true)
  assert.equal(resumed.externalId, id)
})

test('selectModel applies through the session config option', async () => {
  const transport = await open()
  const session = await transport.create({ cwd })
  await session.selectModel('fake/sonnet')
  assert.equal(session.modelOption.currentValue, 'fake/sonnet')
  await assert.rejects(session.selectModel('nope/nope'), /invalid value/)
})

test('images reach the agent when it advertises image prompts', async () => {
  const transport = await open()
  const session = await transport.create({ cwd })
  const events = []
  await session.prompt({
    text: 'look at this',
    images: [{ mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
    onUpdate: (event) => events.push(event),
  })
  assert.ok(events.some((event) => event.type === 'tool'))
})

/** Run one turn and return its reported usage. */
async function turnUsage(overrides) {
  const transport = await open(overrides)
  const session = await transport.create({ cwd })
  const outcome = await session.prompt({ text: 'count the tokens' })
  return outcome.usage
}

test('usage passes through untouched when the profile does not claim folding', async () => {
  // OpenCode's reading: `inputTokens` is already the uncached prompt count, and
  // the cache counters sit beside it. The default must reproduce that exactly —
  // subtracting here would under-report every OpenCode turn.
  const usage = await turnUsage({})
  assert.deepEqual(usage, { inputTokens: 120, outputTokens: 7, cacheReadTokens: 20, reasoningTokens: 3 })
})

test('a profile that folds cached tokens into inputTokens reports a disjoint count', async () => {
  process.env.FAKE_ACP_USAGE = JSON.stringify({
    inputTokens: 120,
    outputTokens: 7,
    thoughtTokens: 3,
    cachedReadTokens: 20,
    cachedWriteTokens: 30,
  })
  try {
    // TRAE CLI's reading: 120 is the whole prompt; 20 read + 30 written are the
    // cached portion, so 70 is newly processed. The harness's `TokenUsage`
    // requires disjoint counts, which is what the profile flag asserts.
    const usage = await turnUsage({ inputTokensIncludeCache: true })
    assert.equal(usage.inputTokens, 70)
    assert.equal(usage.cacheReadTokens, 20)
    assert.equal(usage.cacheWriteTokens, 30)
    assert.equal(usage.outputTokens, 7)
    assert.equal(usage.reasoningTokens, 3)
  } finally {
    delete process.env.FAKE_ACP_USAGE
  }
})

test('the same folded usage is untouched by the default profile', async () => {
  process.env.FAKE_ACP_USAGE = JSON.stringify({
    inputTokens: 120,
    outputTokens: 7,
    cachedReadTokens: 20,
    cachedWriteTokens: 30,
  })
  try {
    // The default is not "detect and subtract": an unfolded agent keeps its own
    // count verbatim, including a cache-write counter the fixture never sent.
    const usage = await turnUsage({})
    assert.equal(usage.inputTokens, 120)
    assert.equal(usage.cacheReadTokens, 20)
    assert.equal(usage.cacheWriteTokens, 30)
  } finally {
    delete process.env.FAKE_ACP_USAGE
  }
})

test('a folded cache larger than the prompt clamps the input at zero', async () => {
  process.env.FAKE_ACP_USAGE = JSON.stringify({
    inputTokens: 100,
    outputTokens: 5,
    cachedReadTokens: 80,
    cachedWriteTokens: 50,
  })
  try {
    // An agent that switches reporting style, or counts only one cache field,
    // must not yield a negative input count — the harness meter would break.
    const usage = await turnUsage({ inputTokensIncludeCache: true })
    assert.equal(usage.inputTokens, 0)
    assert.equal(usage.cacheReadTokens, 80)
    assert.equal(usage.cacheWriteTokens, 50)
    assert.equal(usage.outputTokens, 5)
  } finally {
    delete process.env.FAKE_ACP_USAGE
  }
})

const permissionLog = join(tmpdir(), `dsh-fake-acp-permission-${process.pid}.jsonl`)

/** Read the permission answers the fake agent recorded. */
async function readPermissionLog() {
  try {
    return readFileSync(permissionLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * Run one turn that hits the fake agent's permission request.
 *
 * `FAKE_ACP_PERMISSION` is read by the child at spawn, so it is set (with the
 * log path) before the transport starts and cleared afterwards.
 */
async function permissionTurn({ policy, approve, mode = 'full', logger, overrides = {} } = {}) {
  process.env.FAKE_ACP_PERMISSION = mode
  process.env.FAKE_ACP_PERMISSION_LOG = permissionLog
  try {
    await rm(permissionLog, { force: true })
    const transport = await open({ permission: policy, ...overrides }, logger === undefined ? {} : { logger })
    const session = await transport.create({ cwd })
    const outcome = await session.prompt({
      text: 'apply the patch',
      ...(approve === undefined ? {} : { approve }),
    })
    return { outcome, answers: await readPermissionLog() }
  } finally {
    delete process.env.FAKE_ACP_PERMISSION
    delete process.env.FAKE_ACP_PERMISSION_LOG
  }
}

test('the allow policy answers the agent permission request itself', async () => {
  const { outcome, answers } = await permissionTurn({ policy: 'allow' })
  assert.equal(outcome.stopReason, STOP_REASON.END_TURN, 'the turn continues after the grant')
  assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'approved' }])
})

test('the reject policy denies without asking a human', async () => {
  const { outcome, answers } = await permissionTurn({ policy: 'reject' })
  assert.equal(outcome.stopReason, STOP_REASON.CANCELLED)
  assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'abort' }])
})

test('a reject with no reject option on offer answers cancelled', async () => {
  // The agent offers only "allow"; the only honest denial is a cancelled
  // outcome, which is also what a client sends for a dismissed prompt.
  const { outcome, answers } = await permissionTurn({ policy: 'reject', mode: 'allow-only' })
  assert.equal(outcome.stopReason, STOP_REASON.CANCELLED)
  assert.deepEqual(answers, [{ outcome: 'cancelled' }])
})

test('the ask policy routes the question through the approver and allows on allowed-once', async () => {
  const seen = []
  const approve = async (request) => {
    seen.push(request)
    return 'allowed-once'
  }
  const { outcome, answers } = await permissionTurn({ policy: 'ask', approve })
  assert.equal(outcome.stopReason, STOP_REASON.END_TURN)
  assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'approved' }])
  assert.equal(seen.length, 1, 'exactly one question reaches the approver')
  assert.equal(seen[0].toolName, 'agent.edit', 'the ACP tool kind is the stable identity to report')
  assert.equal(seen[0].reason, 'Write the generated patch to src/app.ts', 'the agent detail becomes the audit reason')
  // The prompt reads like a sentence: the agent's name, the ACP kind mapped
  // through its label, and the agent's own detail.
  assert.equal(seen[0].displayReason.en, 'Fake Agent wants to edit files: Write the generated patch to src/app.ts')
  assert.equal(seen[0].displayReason.zh, 'Fake Agent 请求修改文件：Write the generated patch to src/app.ts')
})

test('the ask policy denies on every non-grant outcome', async () => {
  for (const answer of ['rejected', 'unavailable', 'something-else']) {
    const { outcome, answers } = await permissionTurn({ policy: 'ask', approve: async () => answer })
    assert.equal(outcome.stopReason, STOP_REASON.CANCELLED, `"${answer}" must not grant`)
    assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'abort' }],
      `"${answer}" is answered with the reject option`)
  }
})

test('a cancelled approval withdraws the turn', async () => {
  const { outcome, answers } = await permissionTurn({ policy: 'ask', approve: async () => 'cancelled' })
  assert.equal(outcome.stopReason, STOP_REASON.CANCELLED)
  assert.deepEqual(answers, [{ outcome: 'cancelled' }], 'cancelling the prompt answers cancelled, not a reject option')
})

test('an approver that fails denies and never grants', async () => {
  const errors = []
  const approve = async () => { throw new Error('no approval service') }
  const { outcome, answers } = await permissionTurn({
    policy: 'ask',
    approve,
    logger: { error: (message) => errors.push(message) },
  })
  assert.equal(outcome.stopReason, STOP_REASON.CANCELLED)
  assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'abort' }], 'a failure is not a grant')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /approval for "agent\.edit" was unavailable \(no approval service\); denying/)
})

test('ask with no approver fails closed and reports', async () => {
  const errors = []
  const { outcome, answers } = await permissionTurn({
    policy: 'ask',
    logger: { error: (message) => errors.push(message) },
  })
  assert.equal(outcome.stopReason, STOP_REASON.CANCELLED)
  assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'abort' }],
    'a question outside an approvable turn is denied, never granted')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /asked for permission outside an approvable turn; denying/)
})

test('an approval slower than the event bound is not counted as agent silence', async () => {
  // Waiting on a human produces no agent events; the watchdog must be suspended
  // for the duration of the question, or a slow answer would kill the turn.
  const { outcome, answers } = await permissionTurn({
    policy: 'ask',
    overrides: { eventTimeoutMs: 150 },
    approve: async () => {
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      return 'allowed-once'
    },
  })
  assert.equal(outcome.stopReason, STOP_REASON.END_TURN, 'the turn survives a slow approval')
  assert.deepEqual(answers, [{ outcome: 'selected', optionId: 'approved' }])
})

test('a turn whose events are paced under the bound survives a longer total', async () => {
  // Five events 100ms apart take ~500ms total, well past both bounds, but no
  // single gap comes close to the 300ms bound. A duration-based timeout would
  // kill this turn; a silence-based one must not.
  process.env.FAKE_ACP_PACING_MS = '100'
  process.env.FAKE_ACP_PACING_STEPS = '5'
  try {
    const transport = await open({ eventTimeoutMs: 300, connectTimeoutMs: 300 })
    const session = await transport.create({ cwd })
    const events = []
    const outcome = await session.prompt({
      text: 'keep talking',
      onUpdate: (event) => events.push(event),
    })
    assert.equal(outcome.stopReason, STOP_REASON.END_TURN)
    assert.ok(events.filter((event) => event.type === 'text').length >= 5, 'every paced event arrived')
  } finally {
    delete process.env.FAKE_ACP_PACING_MS
    delete process.env.FAKE_ACP_PACING_STEPS
  }
})

test('a silent turn trips the silence watchdog and is cancelled', async () => {
  process.env.FAKE_ACP_SILENCE_MS = '2000'
  process.env.FAKE_ACP_CONFIG = configLog
  try {
    await rm(configLog, { force: true })
    const transport = await open({ eventTimeoutMs: 150 })
    const session = await transport.create({ cwd })
    await assert.rejects(
      session.prompt({ text: 'go quiet' }),
      (error) => {
        // The failure is a transport failure; the silence marker is how the
        // transport decides to cancel (behaviour pinned below), not something a
        // test should reach into.
        assert.equal(error.name, 'AcpFailure')
        assert.match(error.message, /sent no event for 150ms during session\/prompt/)
        return true
      },
    )
    // Behaviour, not internals: a silent agent is told to stop.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    const calls = await readConfigLog()
    assert.equal(calls.some((call) => call.method === 'session/cancel'), true,
      'the transport cancels the agent it stopped waiting for')
  } finally {
    delete process.env.FAKE_ACP_SILENCE_MS
    delete process.env.FAKE_ACP_CONFIG
  }
})

test('a resumed session re-applies the profile configuration', async () => {
  process.env.FAKE_ACP_CONFIG = configLog
  try {
    // A loaded session reports whatever configuration it was left with. Here
    // that is `fake/sonnet`, while the profile still declares `fake/opus`, so
    // resuming has to re-assert it — otherwise a restored session silently
    // serves the wrong model.
    const transport = await open({ configOptions: { model: 'fake/opus' } })
    const created = await transport.create({ cwd })
    await created.selectModel('fake/sonnet')
    const id = created.externalId
    await created.close()

    await rm(configLog, { force: true })
    const resumed = await transport.resume(id, { cwd })
    const calls = await readConfigLog()
    assert.deepEqual(
      calls.filter((call) => call.method === 'session/set_config_option').map((call) => `${call.configId}=${call.value}`),
      ['model=fake/opus'],
      'the resumed session is put back on the profile model',
    )
    assert.equal(resumed.externalId, id)
  } finally {
    delete process.env.FAKE_ACP_CONFIG
  }
})

test('a catalogue window is read through the declared meta path', async () => {
  const withPath = await open({ contextWindowMetaPath: 'trae.contextWindow' })
  const models = await withPath.catalog({ cwd })
  assert.deepEqual(models.map((model) => model.contextWindow), [475_000, 200_000, 116_000],
    'each model carries the window its own _meta advertises')

  const without = await open()
  const plain = await without.catalog({ cwd })
  assert.deepEqual(plain.map((model) => model.id), ['fake/opus', 'fake/sonnet', 'fake/haiku'])
  assert.equal(plain.some((model) => model.contextWindow !== undefined), false,
    'no declared path, no invented window')

  const wrong = await open({ contextWindowMetaPath: 'trae.missing' })
  assert.equal((await wrong.catalog({ cwd })).some((model) => model.contextWindow !== undefined), false,
    'a path the agent did not publish yields no window')
})
