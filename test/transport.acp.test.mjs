/** Conformance for the ACP transport, driven by a real ACP agent over stdio. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from '../lib/config.js'
import { CAPABILITY } from '../lib/transport/contract.js'
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

async function open(overrides = {}) {
  const transport = new AcpTransport({ ...profile, ...overrides }, cwd, {})
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
  assert.equal(transport.capabilities.has(CAPABILITY.SWITCH_MODEL), true)
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
  await assert.rejects(session.selectModel('nope/nope'), /unknown model/)
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
