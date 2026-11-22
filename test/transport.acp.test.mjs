/** Conformance for the ACP transport, driven by a real ACP agent over stdio. */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from '../lib/config.js'
import { CAPABILITY } from '../lib/transport/contract.js'
import { AcpTransport } from '../lib/transport/acp.js'
import { runTransportConformance } from './conformance.mjs'

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
const profile = resolveAgent('fake', {
  displayName: 'Fake Agent',
  command: process.execPath,
  args: [AGENT],
})
const cwd = fileURLToPath(new URL('.', import.meta.url))

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
