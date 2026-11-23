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

/** The `cli` recipe a command-backed catalogue needs, the way Aiden serves one. */
function catalogCli(overrides = {}) {
  return {
    promptVia: 'arg',
    modelArgs: ['--model', '{model}'],
    resumeArgs: ['--resume', '{session}'],
    sessionIdPath: 'session_id',
    catalogCommand: [process.execPath, CLI, '--catalog-models'],
    catalogJson: { entries: 'models', id: 'id', contextWindow: 'context_length' },
    jsonl: { text: 'message.content' },
    ...overrides,
  }
}

/** A profile whose catalogue comes from a command instead of a declared list. */
function makeCatalogProfile(overrides = {}) {
  return makeProfile({ models: [], cli: catalogCli(), ...overrides })
}

/** Run `body` with extra fake-CLI environment, restoring the old values after. */
async function withFakeEnv(env, body) {
  const saved = new Map()
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
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

test('a configured catalogue command is the catalogue, ids and windows included', async () => {
  // Aiden publishes the gateway's own `context_length`, which is the only window
  // worth metering against, so the transport passes it through untouched.
  const models = await new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd })
  assert.deepEqual(models, [
    { id: 'fast', name: 'fast', contextWindow: 64_000 },
    { id: 'deep', name: 'deep', contextWindow: 200_000 },
  ])
})

test('without a catalogue command the declared list stays authoritative', async () => {
  // The historical reading: a CLI is never spawned just to enumerate models.
  const models = await new CliTransport(makeProfile(), cwd, {}).catalog({ cwd })
  assert.deepEqual(models, [
    { id: 'fast', name: 'Fast' },
    { id: 'deep', name: 'Deep' },
  ])
})

test('a catalogue name path is used when the vendor publishes one', async () => {
  const profile = makeCatalogProfile({
    cli: catalogCli({
      catalogJson: { entries: 'models', id: 'id', name: 'alias', contextWindow: 'context_length' },
    }),
  })
  const models = await withFakeEnv({
    FAKE_CLI_CATALOG_PAYLOAD: JSON.stringify({
      models: [{ id: 'fast', alias: 'Fast model', context_length: 64_000 }],
    }),
  }, () => new CliTransport(profile, cwd, {}).catalog({ cwd }))
  assert.deepEqual(models, [{ id: 'fast', name: 'Fast model', contextWindow: 64_000 }])
})

test('a catalogue drops duplicate ids and unusable entries in source order', async () => {
  const models = await withFakeEnv({
    FAKE_CLI_CATALOG_PAYLOAD: JSON.stringify({
      models: [
        { id: 'fast', context_length: 64_000 },
        { id: 'fast', context_length: 1 },
        { id: 42, context_length: 10 },
        { id: '', context_length: 10 },
        { context_length: 10 },
        { id: 'deep', context_length: 0 },
      ],
    }),
  }, () => new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd }))
  assert.deepEqual(models, [
    { id: 'fast', name: 'fast', contextWindow: 64_000 },
    // A window the vendor does not publish is left to the route default.
    { id: 'deep', name: 'deep' },
  ])
})

test('a catalogue document behind banner text still parses', async () => {
  const models = await withFakeEnv({
    FAKE_CLI_CATALOG_PAYLOAD: 'Checking login...\n{"models":[{"id":"deep","context_length":200000}]}\nwelcome',
  }, () => new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd }))
  assert.deepEqual(models, [{ id: 'deep', name: 'deep', contextWindow: 200_000 }])
})

test('a failing catalogue command fails with the command and its stderr', async () => {
  await withFakeEnv({ FAKE_CLI_CATALOG_MODE: 'error' }, async () => {
    await assert.rejects(new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd }), (error) => {
      assert.equal(
        error.message.startsWith(`"${process.execPath}" catalogue command`),
        true,
        'the message names the command that failed',
      )
      assert.match(error.message, /catalogue command exited with code 2: fake-cli: catalogue fetch exploded/)
      return true
    })
  })
})

test('a catalogue dump that is not JSON, or misses the mapped array, fails by name', async () => {
  await withFakeEnv({ FAKE_CLI_CATALOG_PAYLOAD: 'no json here' }, async () => {
    await assert.rejects(
      new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd }),
      /catalogue command did not print JSON/,
    )
  })
  await withFakeEnv({ FAKE_CLI_CATALOG_PAYLOAD: '{"rows":[]}' }, async () => {
    await assert.rejects(
      new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd }),
      /no model array at "models"/,
    )
  })
})

test('a catalogue command that outlives its own bound is killed and reported', async () => {
  await withFakeEnv({ FAKE_CLI_CATALOG_MODE: 'sleep' }, async () => {
    // The fake stalls five seconds; the recipe bounds the catalogue at 50ms, well
    // below the default, so the assertion also proves the field is honoured.
    const profile = makeCatalogProfile({ cli: catalogCli({ catalogTimeoutMs: 50 }) })
    const started = Date.now()
    await assert.rejects(
      new CliTransport(profile, cwd, {}).catalog({ cwd }),
      /catalogue command timed out after 50ms/,
    )
    assert.ok(Date.now() - started < 3_000, 'the timeout kills the child instead of waiting it out')
  })
})

test('an aborted catalogue request kills its child', async () => {
  await withFakeEnv({ FAKE_CLI_CATALOG_MODE: 'sleep' }, async () => {
    const controller = new AbortController()
    const pending = new CliTransport(makeCatalogProfile(), cwd, {}).catalog({ cwd, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(pending, /catalogue command was cancelled/)
  })
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

test('cache token paths become disjoint usage counts', async () => {
  const usageCli = (cacheWrite) => ({
    promptVia: 'stdin',
    jsonl: {
      text: 'message.content',
      usage: {
        input: 'usage.input_tokens',
        output: 'usage.output_tokens',
        cacheRead: 'usage.cache_read_input_tokens',
        cacheWrite,
      },
    },
  })
  // The fake reports 11 uncached input tokens beside 300 read and 20 written.
  const transport = new CliTransport(makeProfile({ cli: usageCli('usage.cache_creation_input_tokens') }), cwd, {})
  const session = await transport.create({ cwd })
  const outcome = await session.prompt({ text: 'hello' })
  assert.deepEqual(outcome.usage, {
    inputTokens: 11,
    outputTokens: 4,
    cacheReadTokens: 300,
    cacheWriteTokens: 20,
  })
  assert.equal(
    outcome.usage.inputTokens + outcome.usage.cacheReadTokens + outcome.usage.cacheWriteTokens,
    331,
    'the three prompt counts stay disjoint; the harness adds them up',
  )

  // A count the agent did not publish is omitted, not reported as zero.
  const partial = new CliTransport(makeProfile({ cli: usageCli('usage.absent_write') }), cwd, {})
  const partialSession = await partial.create({ cwd })
  const partialOutcome = await partialSession.prompt({ text: 'hello' })
  assert.deepEqual(partialOutcome.usage, {
    inputTokens: 11,
    outputTokens: 4,
    cacheReadTokens: 300,
  })
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

test('the aiden-claude preset resolves to the measured launcher invocation', () => {
  // Resolved through the schema, because the materialized `cli` block is what
  // used to erase a preset's recipe: on a preset-only entry every array comes
  // back as `[]` and every object as `{}` before the preset merge runs.
  const entry = new Config({ agents: { aiden: { preset: 'aiden-claude' } } }).agents.get().aiden
  const profile = resolveEntry('aiden', entry)

  assert.equal(profile.transport, 'cli')
  assert.equal(profile.command, 'aiden')
  assert.deepEqual(profile.args, [
    'x', 'claude',
    '--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
  ])
  assert.equal(profile.format, 'jsonl')
  // Print mode takes the prompt as the last argument, and Aiden rejects a
  // passthrough `--model`, so the gateway model goes through its own flag.
  assert.equal(profile.cli.promptVia, 'arg')
  assert.deepEqual(profile.cli.modelArgs, ['--model', '{model}'])
  assert.deepEqual(profile.cli.resumeArgs, ['--resume', '{session}'])
  assert.equal(profile.cli.sessionIdPath, 'session_id')
  assert.deepEqual(profile.cli.catalogCommand, ['aiden', 'x', 'models', '--claude', '--json'])
  assert.deepEqual(profile.cli.catalogJson, { entries: 'models', id: 'id', contextWindow: 'context_length' })
  // Streaming deltas only: the recurring `assistant` events repeat the whole
  // message and must stay unmapped, and `result` carries the token counts.
  assert.deepEqual(profile.cli.jsonl, {
    text: 'event.delta.text',
    reasoning: 'event.delta.thinking',
    tool: 'event.content_block.name',
    error: { path: 'is_error', equals: 'true' },
    usage: {
      input: 'usage.input_tokens',
      output: 'usage.output_tokens',
      cacheRead: 'usage.cache_read_input_tokens',
      cacheWrite: 'usage.cache_creation_input_tokens',
    },
  })
  // The catalogue is live per account, so the preset declares none: the picker
  // must ask the transport, which asks the gateway.
  assert.deepEqual(profile.models, [])
  // Aiden signs in to ByteCloud itself; nothing comes from the harness store.
  assert.deepEqual(profile.credentials, {})
  // Claude Code's own session id is enough for RESUME, and a one-process-per-turn
  // CLI promises nothing else.
  const transport = new CliTransport(profile, cwd, {})
  assert.equal(transport.capabilities.has(CAPABILITY.RESUME), true)
  assert.equal(transport.capabilities.has(CAPABILITY.SWITCH_MODEL), false)
  // The recipe must also pass the load-time gate, or the route never starts.
  assertCliRecipe('aiden', profile)
})

test('a CLI that is not installed fails the turn instead of the process', async () => {
  // A missing executable emits `error` on the child, not `exit`; unhandled it
  // would throw in the host instead of reporting which command was missing.
  const profile = makeProfile({
    command: 'dsh-test-missing-binary',
    cli: { promptVia: 'stdin', jsonl: { text: 'text' } },
  })
  const session = await new CliTransport(profile, cwd, {}).create({ cwd })
  await assert.rejects(session.prompt({ text: 'x' }), (error) => {
    assert.match(error.message, /"dsh-test-missing-binary" failed to start: spawn dsh-test-missing-binary ENOENT/)
    // Regression guard: a spawn failure must not surface as an exit report,
    // which is what happens if the check moves back after the exit wait.
    assert.doesNotMatch(error.message, /exited with code/)
    return true
  })
})

test('a catalogue command that cannot start is reported by name', async () => {
  const profile = makeCatalogProfile({
    cli: catalogCli({ catalogCommand: ['dsh-test-missing-catalogue-binary', 'models'] }),
  })
  await assert.rejects(new CliTransport(profile, cwd, {}).catalog({ cwd }), (error) => {
    assert.match(
      error.message,
      /"dsh-test-missing-catalogue-binary" catalogue command failed to start: spawn dsh-test-missing-catalogue-binary ENOENT/,
    )
    assert.doesNotMatch(error.message, /exited with code/, 'a failed spawn is not an exit')
    return true
  })
})

test('a catalogue command that ignores SIGTERM is still killed at the timeout', async () => {
  await withFakeEnv({ FAKE_CLI_CATALOG_MODE: 'stubborn' }, async () => {
    const profile = makeCatalogProfile({ cli: catalogCli({ catalogTimeoutMs: 50 }) })
    const started = Date.now()
    await assert.rejects(
      new CliTransport(profile, cwd, {}).catalog({ cwd }),
      /catalogue command timed out after 50ms/,
    )
    const elapsed = Date.now() - started
    // SIGTERM lands at 50ms and is ignored, so the rejection can only arrive
    // after the SIGKILL grace — but well before the fixture would exit at 5s.
    assert.ok(elapsed >= 1_900, `the escalation waited its grace (${elapsed}ms)`)
    assert.ok(elapsed < 4_500, `the escalation killed the child instead of waiting it out (${elapsed}ms)`)
  })
})
