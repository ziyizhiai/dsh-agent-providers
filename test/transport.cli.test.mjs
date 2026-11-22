/** Conformance for the configure-driven CLI transport. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from '../lib/config.js'
import { CAPABILITY } from '../lib/transport/contract.js'
import { Config, resolveAgent as resolveEntry } from '../lib/config.js'
import { CliTransport, assertCliRecipe, pick } from '../lib/transport/cli.js'
import { runTransportConformance } from './conformance.mjs'

const CLI = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))
const cwd = fileURLToPath(new URL('.', import.meta.url))

let dir
/** A fresh, empty prompt log per test so counts never leak across tests. */
async function logPath() {
  if (dir === undefined) dir = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
  const file = join(dir, 'prompts.jsonl')
  await rm(file, { force: true })
  return file
}

after(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/** A recipe in the shape a real CLI integration would use. */
function makeProfile(overrides = {}) {
  return resolveAgent('local-cli', {
    displayName: 'Local CLI',
    transport: 'cli',
    format: 'jsonl',
    command: process.execPath,
    args: [CLI],
    models: [
      { id: 'fast', name: 'Fast', contextWindow: 64_000 },
      { id: 'deep', name: 'Deep', contextWindow: 200_000 },
    ],
    cli: {
      promptVia: 'stdin',
      resumeArgs: ['--resume', '{session}'],
      sessionIdPath: 'session_id',
      modelArgs: ['--model', '{model}'],
      jsonl: {
        text: 'message.content',
        reasoning: 'message.reasoning',
        tool: 'message.tool',
        error: { path: 'is_error', equals: 'true' },
        usage: { input: 'usage.input_tokens', output: 'usage.output_tokens' },
      },
    },
    ...overrides,
  })
}

test('pick reads dotted paths safely', () => {
  assert.equal(pick({ a: { b: [1] } }, 'a.b.0'), 1)
  assert.equal(pick({ a: 1 }, 'a.b.c'), undefined)
  assert.equal(pick(null, 'a'), undefined)
  assert.equal(pick({ a: 1 }, ''), undefined)
})

test('recipe typos fail at load time', () => {
  assert.throws(
    () => assertCliRecipe('x', { ...makeProfile(), cli: undefined }),
    /declares no cli recipe/,
  )
  assert.throws(
    () => assertCliRecipe('x', { ...makeProfile(), cli: { promptVia: 'telepathy' } }),
    /promptVia/,
  )
  assert.throws(
    () => assertCliRecipe('x', { ...makeProfile(), format: 'xml' }),
    /format/,
  )
  assert.throws(
    () => assertCliRecipe('x', {
      ...makeProfile(),
      cli: { promptVia: 'stdin', sessionIdPath: 'session_id', jsonl: { text: 'message.content' } },
    }),
    /could never resume/,
  )
})

test('advertises exactly the capabilities a one-process-per-turn CLI can keep', () => {
  const transport = new CliTransport(makeProfile(), cwd, {})
  assert.equal(transport.capabilities.has(CAPABILITY.RESUME), true)
  assert.equal(transport.capabilities.has(CAPABILITY.LIST), false)
  assert.equal(transport.capabilities.has(CAPABILITY.FORK), false)
  assert.equal(transport.capabilities.has(CAPABILITY.SWITCH_MODEL), false)
  assert.equal(transport.capabilities.has(CAPABILITY.IMAGES), false)

  const noResume = new CliTransport(
    makeProfile({ cli: { promptVia: 'stdin', jsonl: { text: 'message.content' } } }),
    cwd, {},
  )
  assert.equal(noResume.capabilities.has(CAPABILITY.RESUME), false)
})

test('a schema-parsed entry with no resume template keeps RESUME off', () => {
  // The schema materializes `resumeArgs` as `[]`, so presence alone must never
  // be read as a promise; only a non-empty template plus an id path counts.
  const config = Config({
    agents: {
      bare: {
        transport: 'cli',
        command: 'agent',
        cli: { promptVia: 'stdin', jsonl: { text: 'text' } },
      },
    },
  })
  const profile = resolveEntry('bare', config.agents.get().bare)
  assert.deepEqual(profile.cli.resumeArgs, [])
  const transport = new CliTransport(profile, cwd, {})
  assert.equal(transport.capabilities.has(CAPABILITY.RESUME), false)
})

test('the profile catalogue is authoritative', async () => {
  const transport = new CliTransport(makeProfile(), cwd, {})
  const models = await transport.catalog({ cwd })
  assert.deepEqual(models.map((model) => model.id), ['fast', 'deep'])
})

test('satisfies the transport contract', async (t) => {
  const file = await logPath()
  process.env.FAKE_CLI_PROMPTS = file
  try {
    await runTransportConformance({ ...t, cwd }, {
      makeTransport: async () => new CliTransport(makeProfile(), cwd, {}),
      capabilities: { resume: true, list: false },
    })
  } finally {
    delete process.env.FAKE_CLI_PROMPTS
  }
})

test('jsonl events become contract events, and the session id is discovered', async () => {
  const file = await logPath()
  process.env.FAKE_CLI_PROMPTS = file
  try {
    const transport = new CliTransport(makeProfile(), cwd, {})
    const session = await transport.create({ cwd })
    assert.match(session.externalId, /^cli-/, 'a fresh CLI session starts with a local placeholder id')

    const events = []
    const outcome = await session.prompt({ text: 'hello', onUpdate: (event) => events.push(event) })
    assert.deepEqual(outcome.stopReason, 'end_turn')
    assert.deepEqual(outcome.usage, { inputTokens: 11, outputTokens: 4 })
    assert.equal(events[0].type, 'reasoning')
    assert.equal(events[1].type, 'tool')
    assert.equal(events[2].type, 'text')
    assert.match(session.externalId, /^ses-/, 'the agent-issued id replaces the placeholder')

    const logged = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(logged.length, 1)
    assert.equal(logged[0].prompt, 'hello')
  } finally {
    delete process.env.FAKE_CLI_PROMPTS
  }
})

test('the model is applied at spawn', async () => {
  const file = await logPath()
  process.env.FAKE_CLI_PROMPTS = file
  try {
    const transport = new CliTransport(makeProfile(), cwd, {})
    const session = await transport.create({ cwd })
    await session.selectModel('deep')
    const events = []
    await session.prompt({ text: 'x', onUpdate: (event) => events.push(event) })
    const logged = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(logged.at(-1).model, 'deep')
    assert.match(events.at(-1).text, /done\(deep\)/)
  } finally {
    delete process.env.FAKE_CLI_PROMPTS
  }
})

test('resuming passes the stored id back to the CLI', async () => {
  const file = await logPath()
  process.env.FAKE_CLI_PROMPTS = file
  try {
    const transport = new CliTransport(makeProfile(), cwd, {})
    const session = await transport.resume('ses-known', { cwd })
    assert.equal(session.resumed, true)
    await session.prompt({ text: 'again' })
    const logged = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(logged.at(-1).sessionId, 'ses-known', 'the CLI receives --resume ses-known')
  } finally {
    delete process.env.FAKE_CLI_PROMPTS
  }
})

test('a refusal is reported as refusal, not as success', async () => {
  process.env.FAKE_CLI_MODE = 'refusal'
  try {
    const transport = new CliTransport(makeProfile(), cwd, {})
    const session = await transport.create({ cwd })
    const events = []
    const outcome = await session.prompt({ text: 'no', onUpdate: (event) => events.push(event) })
    assert.equal(outcome.stopReason, 'refusal')
  } finally {
    delete process.env.FAKE_CLI_MODE
  }
})

test('a crashing CLI fails the turn with its stderr', async () => {
  process.env.FAKE_CLI_MODE = 'crash'
  try {
    const transport = new CliTransport(makeProfile(), cwd, {})
    const session = await transport.create({ cwd })
    await assert.rejects(session.prompt({ text: 'x' }), /exited with code 3.*exploded/s)
  } finally {
    delete process.env.FAKE_CLI_MODE
  }
})

test('text format streams raw output as one text channel', async () => {
  const transport = new CliTransport(makeProfile({ format: 'text', cli: { promptVia: 'stdin' } }), cwd, {})
  const session = await transport.create({ cwd })
  const events = []
  const outcome = await session.prompt({ text: 'plain', onUpdate: (event) => events.push(event) })
  assert.equal(outcome.stopReason, 'end_turn')
  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('')
  assert.match(text, /plain/)
})
