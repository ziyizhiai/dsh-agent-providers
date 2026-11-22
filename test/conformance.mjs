/**
 * Transport conformance: the same assertions run against every transport, so
 * a new backend is proven against the contract rather than against itself.
 *
 * Share {@link runTransportConformance} with a new transport's own test file.
 */
import assert from 'node:assert/strict'
import { CAPABILITY } from '../lib/transport/contract.js'

/** Assert the transport advertises a coherent capability set. */
export function assertCapabilities(transport, { resume = false, list = false } = {}) {
  assert.equal(typeof transport.kind, 'string')
  assert.ok(transport.capabilities instanceof Set, 'capabilities must be a Set')
  assert.equal(transport.capabilities.has(CAPABILITY.RESUME), resume,
    `RESUME should be ${resume ? 'advertised' : 'absent'}`)
  assert.equal(transport.capabilities.has(CAPABILITY.LIST), list,
    `LIST should be ${list ? 'advertised' : 'absent'}`)
}

/** Run the assertions every transport must satisfy. */
export async function runTransportConformance(t, { makeTransport, capabilities }) {
  const transport = await makeTransport()

  assertCapabilities(transport, capabilities)

  const models = await transport.catalog({ cwd: t.cwd })
  assert.ok(Array.isArray(models), 'catalog must return an array')
  assert.ok(models.length > 0, 'catalog must offer at least one model')
  for (const model of models) {
    assert.equal(typeof model.id, 'string')
    assert.notEqual(model.id.length, 0)
    assert.equal(typeof model.name, 'string')
  }

  const session = await transport.create({ cwd: t.cwd })
  assert.equal(typeof session.externalId, 'string')
  assert.notEqual(session.externalId.length, 0)
  assert.equal(session.resumed, false)

  const events = []
  const outcome = await session.prompt({
    text: 'conformance probe',
    onUpdate: (event) => events.push(event),
  })
  assert.equal(typeof outcome.stopReason, 'string')
  assert.ok(events.length > 0, 'a turn must report at least one event')
  assert.ok(events.some((event) => event.type === 'text'), 'a turn must report text')
  assert.equal(
    events.filter((event) => !['text', 'reasoning', 'tool', 'plan', 'title', 'model', 'context', 'raw'].includes(event.type)).length,
    0,
    'only contract event types may be emitted',
  )

  await session.selectModel(models[0].id)
  await session.close()

  if (capabilities.list) {
    const listed = await transport.list({ cwd: t.cwd })
    assert.ok(Array.isArray(listed))
  }

  await transport.close('conformance complete')
}
