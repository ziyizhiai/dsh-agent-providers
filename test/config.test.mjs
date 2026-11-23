/**
 * The documented configuration must validate, and the presets must expand to
 * exactly what the README claims.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, resolveAgent } from '../lib/config.js'
import { PRESETS } from '../lib/presets.js'
import { assertCliRecipe } from '../lib/transport/cli.js'

/** Parse a plugin config section the way the loader does. */
function parse(raw) {
  return Config(raw)
}

test('the documented opencode MVP section validates', () => {
  const config = parse({
    agents: {
      'opencode-go': {
        preset: 'opencode',
        displayName: 'OpenCode Go',
        credentials: { OPENCODE_API_KEY: 'CUSTOM_OPENCODE_API_KEY' },
      },
    },
  })
  const agents = config.agents.get()
  assert.equal(agents['opencode-go'].preset, 'opencode')
  assert.equal(agents['opencode-go'].displayName, 'OpenCode Go')
  assert.deepEqual(agents['opencode-go'].credentials, { OPENCODE_API_KEY: 'CUSTOM_OPENCODE_API_KEY' })
  // The documented section must also survive resolution into a runnable backend.
  const profile = resolveAgent('opencode-go', agents['opencode-go'])
  assert.equal(profile.command, 'opencode')
})

test('a preset alone survives schema materialization', () => {
  // The schema materializes absent fields (`args: []`, `command: ''`, `auth: {}`).
  // Treating those as "the profile said something" erases the preset — the bug
  // that once started OpenCode's TUI instead of its ACP server.
  for (const preset of ['opencode', 'opencode2', 'claude-code', 'codex', 'traex', 'aiden-claude']) {
    const config = new Config({ agents: { a: { preset } } })
    const profile = resolveAgent('a', config.agents.get().a)
    assert.notEqual(profile.command, '', `${preset} keeps its command`)
    assert.equal(profile.displayName.length > 0, true, `${preset} keeps its display name`)
  }

  const claudeEntry = new Config({ agents: { a: { preset: 'claude-code' } } }).agents.get().a
  const claude = resolveAgent('a', claudeEntry)
  assert.deepEqual(claude.models.map((model) => model.id), ['default', 'opus', 'sonnet', 'haiku', 'fable'],
    'the Claude model aliases its agent publishes')
  assert.equal(claude.auth, undefined, 'no sign-in call for an agent that needs none')

  const codexEntry = new Config({ agents: { a: { preset: 'codex' } } }).agents.get().a
  const codex = resolveAgent('a', codexEntry)
  assert.equal(codex.auth.methodId, 'api-key')
  assert.deepEqual(codex.auth.params, { _meta: { 'api-key': { apiKey: '{value}' } } })
  assert.equal(codex.catalog, 'probe', 'the model list only exists after signing in')
})

test('a profile override still wins over the preset', () => {
  const config = new Config({
    agents: { a: { preset: 'codex', command: '/opt/custom-codex', displayName: 'Mine' } },
  })
  const profile = resolveAgent('a', config.agents.get().a)
  assert.equal(profile.command, '/opt/custom-codex')
  assert.equal(profile.displayName, 'Mine')
})

test('a preset expands to a runnable backend', () => {
  const profile = resolveAgent('opencode-go', { preset: 'opencode' })
  assert.equal(profile.transport, 'acp')
  assert.equal(profile.command, 'opencode')
  assert.deepEqual(profile.args, ['acp'])
  assert.equal(profile.displayName, PRESETS.opencode.displayName)
  // OpenCode's ACP server ignores OPENCODE_API_KEY for inference; the preset
  // supplies the credential *document* its auth store reads.
  assert.deepEqual(profile.credentials, {
    OPENCODE_AUTH_CONTENT: {
      ref: 'CUSTOM_OPENCODE_API_KEY',
      template: '{"opencode-go":{"type":"api","key":"{value}"}}',
    },
  })
  // It asks the client before a gated tool; the question goes to the harness
  // approval service rather than being auto-approved.
  assert.equal(profile.permission, 'ask')
  assert.equal(profile.continuity, 'auto')
})

test('every ACP preset routes permission questions to the host', () => {
  // The plumbing is one generic path in the transport, so the presets that can
  // ask must all opt in; `cli-jsonl` has no permission concept at all.
  for (const preset of ['opencode', 'opencode2', 'claude-code', 'codex', 'gemini', 'traex']) {
    assert.equal(resolveAgent('a', { preset }).permission, 'ask', `${preset} asks the host`)
  }
  assert.equal(resolveAgent('a', { preset: 'cli-jsonl', command: 'x' }).permission, 'allow', 'the CLI transport keeps the plain default')
})

test('the opencode2 preset targets the v2 binary and its own auth store', () => {
  // v2 is a different binary with a different login store; it needs no credential
  // mapping (and therefore does not fail on a machine without the v1 key).
  const profile = resolveAgent('oc2', { preset: 'opencode2' })
  assert.equal(profile.transport, 'acp')
  assert.equal(profile.command, 'opencode2')
  assert.deepEqual(profile.args, ['acp'])
  assert.equal(profile.displayName, 'OpenCode v2')
  assert.deepEqual(profile.credentials, {}, 'v2 signs in through its own auth store')
  // Measured on 2.3.2: inputTokens is already the uncached count (69 beside
  // cacheRead 59344), so no cache subtraction, unlike TRAE CLI.
  assert.equal(profile.inputTokensIncludeCache, false)
  assert.equal(profile.permission, 'ask')
})

test('the traex preset expands to the TRAE CLI ACP server', () => {
  // `traex` is TRAE CLI ("traecli" 0.216.0). `acp` is a subcommand *group*, so
  // the server itself is `acp serve` — `traex acp` alone only prints help.
  const profile = resolveAgent('traex-route', { preset: 'traex' })
  assert.equal(profile.transport, 'acp')
  assert.equal(profile.command, 'traex')
  assert.deepEqual(profile.args, ['acp', 'serve'])
  assert.equal(profile.displayName, 'TRAE CLI')
  // It signs in through its own store (`~/.trae/traecli.toml`), so nothing is
  // mapped from the harness credential store.
  assert.deepEqual(profile.credentials, {}, 'it reuses its own login instead of a mapped credential')
  // Measured usage folds cache read *and* write into `inputTokens`, while the
  // harness needs disjoint counts; the preset asks the transport to subtract.
  assert.equal(profile.inputTokensIncludeCache, true)
  // Its own permission requests go through the DSH approval service instead of
  // being auto-approved, and its per-model window comes from `_meta`.
  assert.equal(profile.permission, 'ask')
  assert.equal(profile.contextWindowMetaPath, 'trae.contextWindow')
  // The shared defaults are untouched.
  assert.equal(profile.continuity, 'auto')
  assert.equal(profile.catalog, 'auto')
})

test('the traex preset survives schema materialization', () => {
  // The schema materializes `args: []` / `command: ''`; none of it may erase the
  // `acp serve` group or the fields that bind it to the harness's own seams.
  const entry = new Config({ agents: { a: { preset: 'traex' } } }).agents.get().a
  const profile = resolveAgent('a', entry)
  assert.equal(profile.command, 'traex')
  assert.deepEqual(profile.args, ['acp', 'serve'], 'the preset supplies the whole subcommand group')
  assert.equal(profile.displayName, 'TRAE CLI')
  assert.equal(profile.inputTokensIncludeCache, true)
  assert.equal(profile.permission, 'ask')
  assert.equal(profile.contextWindowMetaPath, 'trae.contextWindow')
})

test('the ask permission policy is a schema value', () => {
  // `ask` is a first-class policy, not a profile that happens to look like one:
  // the schema has to accept it, and `resolveAgent` must pass it through
  // instead of falling back to the non-interactive default.
  const config = parse({ agents: { a: { command: 'agent', permission: 'ask' } } })
  assert.equal(config.agents.get().a.permission, 'ask')
  assert.equal(resolveAgent('a', config.agents.get().a).permission, 'ask')
  assert.throws(() => parse({ agents: { a: { command: 'agent', permission: 'maybe' } } }))
})

test('contextWindowMetaPath resolves only when a path is set', () => {
  const pinned = resolveAgent('x', { command: 'a', contextWindowMetaPath: 'trae.contextWindow' })
  assert.equal(pinned.contextWindowMetaPath, 'trae.contextWindow')
  const unset = resolveAgent('x', { command: 'a' })
  assert.equal('contextWindowMetaPath' in unset, false, 'no invented path for agents without one')
  // The schema leaves it absent so a preset can supply it (`mergePreset` skips
  // empty strings, which is how an override turns a preset path off).
  const entry = parse({ agents: { plain: { command: 'agent' } } }).agents.get().plain
  assert.equal(entry.contextWindowMetaPath, undefined)
  const cleared = resolveAgent('x', { command: 'a', contextWindowMetaPath: '' })
  assert.equal('contextWindowMetaPath' in cleared, false)
})

test('a traex entry can override the preset, including the cache-folded flag', () => {
  const profile = resolveAgent('traex-route', {
    preset: 'traex',
    command: '/opt/traex',
    args: ['custom'],
  })
  assert.equal(profile.command, '/opt/traex')
  assert.deepEqual(profile.args, ['custom'])

  // `mergePreset` must not swallow a boolean `false`: an agent that starts
  // reporting disjoint counts has to be able to turn the subtraction off.
  const disjoint = resolveAgent('traex-route', { preset: 'traex', inputTokensIncludeCache: false })
  assert.equal(disjoint.inputTokensIncludeCache, false)
})

test('a preset field can be overridden', () => {
  const profile = resolveAgent('oc', {
    preset: 'opencode',
    command: 'npx',
    args: ['-y', 'opencode-ai', 'acp'],
    extraArgs: ['--print-logs'],
    permission: 'reject',
    idleReleaseMs: 1_000,
  })
  assert.equal(profile.command, 'npx')
  assert.deepEqual(profile.args, ['-y', 'opencode-ai', 'acp', '--print-logs'])
  assert.equal(profile.permission, 'reject')
  assert.equal(profile.idleReleaseMs, 1_000)
})

test('unknown presets and malformed entries are rejected by name', () => {
  assert.throws(() => resolveAgent('x', { preset: 'nope' }), /unknown preset "nope"/)
  // The error is how someone who mistyped a preset discovers the usable ones,
  // so the list must include every preset that resolves.
  assert.throws(() => resolveAgent('x', { preset: 'nope' }), /known: .*\btraex\b/)
  assert.throws(() => resolveAgent('x', { command: '' }), /non-empty command/)
  assert.throws(() => resolveAgent('x', { command: 'a', transport: 'carrier-pigeon' }), /unknown transport/)
  assert.throws(
    () => resolveAgent('x', { command: 'a', models: [{ id: 'm' }, { id: 'm' }] }),
    /declares model "m" twice/,
  )
  assert.throws(() => resolveAgent('x', { command: 'a', displayName: '  ' }), /empty displayName/)
})

test('a cli recipe keeps its nested facts and fills defaults', () => {
  const profile = resolveAgent('trae', {
    transport: 'cli',
    command: 'trae',
    args: ['run'],
    cli: {
      resumeArgs: ['--continue', '{session}'],
      sessionIdPath: 'session_id',
      jsonl: { text: 'message.content', error: { path: 'is_error' } },
    },
  })
  assert.equal(profile.transport, 'cli')
  assert.equal(profile.format, 'jsonl')
  assert.equal(profile.cli.promptVia, 'stdin')
  assert.deepEqual(profile.cli.resumeArgs, ['--continue', '{session}'])
  assert.equal(profile.cli.sessionIdPath, 'session_id')
  assert.deepEqual(profile.cli.jsonl.error, { path: 'is_error', equals: 'true' })
})

test('a credential template must have somewhere to put the secret', () => {
  assert.throws(
    () => resolveAgent('x', { command: 'a', credentials: { K: { ref: 'R', template: '{"a":1}' } } }),
    /has no \{value\} placeholder/,
  )
  assert.throws(
    () => resolveAgent('x', { command: 'a', credentials: { K: '' } }),
    /empty credential ref/,
  )
  assert.throws(
    () => resolveAgent('x', { command: 'a', credentials: { K: { template: '{value}' } } }),
    /invalid credential entry/,
  )
})

test('a bare ref and a template both normalize to { ref, template? }', () => {
  const profile = resolveAgent('x', {
    command: 'a',
    credentials: { PLAIN: 'SOME_REF', DOC: { ref: 'OTHER_REF', template: '{"k":"{value}"}' } },
  })
  assert.deepEqual(profile.credentials, {
    PLAIN: { ref: 'SOME_REF' },
    DOC: { ref: 'OTHER_REF', template: '{"k":"{value}"}' },
  })
})

test('model metadata survives resolution', () => {
  const profile = resolveAgent('x', {
    command: 'a',
    models: [{ id: 'm', contextWindow: 100_000, maxTokens: 8_000 }, { id: 'n' }],
  })
  assert.deepEqual(profile.models[0], { id: 'm', name: 'm', contextWindow: 100_000, maxTokens: 8_000 })
  assert.deepEqual(profile.models[1], { id: 'n', name: 'n' })
})

test('resolution owns the defaults, not the schema', () => {
  // The schema must not materialize a default that a preset was meant to
  // supply. Defaults live in resolveAgent so a preset can win.
  const config = parse({ agents: { plain: { command: 'agent', args: ['acp'] } } })
  const entry = config.agents.get().plain
  for (const field of ['transport', 'format', 'permission', 'continuity', 'inputTokensIncludeCache', 'contextWindowMetaPath']) {
    assert.equal(entry[field], undefined, `${field} must not be schema-defaulted`)
  }

  const profile = resolveAgent('plain', entry)
  assert.equal(profile.transport, 'acp')
  assert.equal(profile.format, 'jsonl')
  assert.equal(profile.permission, 'allow')
  assert.equal(profile.continuity, 'auto')
  assert.deepEqual(profile.models, [])
  assert.deepEqual(profile.credentials, {})
  assert.deepEqual(profile.args, ['acp'])
})

test('a preset argument survives the schema-materialized empty arrays', () => {
  // Regression: `args: []` from the schema once beat the preset's ['acp'], so
  // opencode started its TUI instead of the ACP server and never handshook.
  const config = parse({ agents: { oc: { preset: 'opencode', command: 'opencode' } } })
  const profile = resolveAgent('oc', config.agents.get().oc)
  assert.deepEqual(profile.args, ['acp'], 'the preset supplies the acp argument')
  assert.equal(profile.transport, 'acp')

  // A non-empty user value still wins.
  const explicit = parse({ agents: { oc: { preset: 'opencode', command: 'opencode', args: ['--acp'] } } })
  assert.deepEqual(resolveAgent('oc', explicit.agents.get().oc).args, ['--acp'])
})

test('a preset catalogue recipe survives the schema round trip', () => {
  // Regression: the schema materializes `cli` on a preset-only entry
  // (`resumeArgs: []`, `catalogJson: {}`, `jsonl: { error: {}, usage: {} }`), so
  // a shallow preset merge would replace the whole recipe with emptiness and
  // lose `promptVia: 'arg'` plus the catalogue command.
  const entry = parse({ agents: { aiden: { preset: 'aiden-claude' } } }).agents.get().aiden
  const profile = resolveAgent('aiden', entry)
  assert.equal(profile.cli.promptVia, 'arg')
  assert.deepEqual(profile.cli.catalogCommand, ['aiden', 'x', 'models', '--claude', '--json'])
  assert.deepEqual(profile.cli.catalogJson, { entries: 'models', id: 'id', contextWindow: 'context_length' })
  assert.equal(profile.cli.jsonl.text, 'event.delta.text')

  // A profile may adjust one nested recipe field without re-declaring the rest.
  const tweaked = parse({ agents: { aiden: { preset: 'aiden-claude', cli: { catalogTimeoutMs: 30_000 } } } })
  const tweakedProfile = resolveAgent('aiden', tweaked.agents.get().aiden)
  assert.equal(tweakedProfile.cli.catalogTimeoutMs, 30_000)
  assert.deepEqual(tweakedProfile.cli.catalogCommand, ['aiden', 'x', 'models', '--claude', '--json'])
  assert.equal(tweakedProfile.cli.promptVia, 'arg')
})

test('a hand-written cli catalogue recipe keeps every new field', () => {
  const config = parse({
    agents: {
      vendor: {
        transport: 'cli',
        command: 'vendor',
        format: 'jsonl',
        cli: {
          promptVia: 'arg',
          resumeArgs: ['--resume', '{session}'],
          sessionIdPath: 'session_id',
          modelArgs: ['--model', '{model}'],
          catalogCommand: ['vendor', 'models', '--json'],
          catalogJson: { entries: 'data.items', id: 'name', name: 'label', contextWindow: 'window' },
          catalogTimeoutMs: 5_000,
          jsonl: {
            text: 'delta.text',
            usage: {
              input: 'usage.in',
              output: 'usage.out',
              cacheRead: 'usage.cache_read',
              cacheWrite: 'usage.cache_create',
            },
          },
        },
      },
    },
  })
  const profile = resolveAgent('vendor', config.agents.get().vendor)
  assert.deepEqual(profile.cli.catalogCommand, ['vendor', 'models', '--json'])
  assert.deepEqual(profile.cli.catalogJson, {
    entries: 'data.items',
    id: 'name',
    name: 'label',
    contextWindow: 'window',
  })
  assert.equal(profile.cli.catalogTimeoutMs, 5_000)
  assert.deepEqual(profile.cli.jsonl.usage, {
    input: 'usage.in',
    output: 'usage.out',
    cacheRead: 'usage.cache_read',
    cacheWrite: 'usage.cache_create',
  })
  assert.doesNotThrow(() => assertCliRecipe('vendor', profile))
})

test('a cli recipe that would fail later is rejected at load', () => {
  const profile = (cli) => resolveAgent('x', {
    transport: 'cli',
    command: 'vendor',
    format: 'jsonl',
    cli: { promptVia: 'arg', jsonl: { text: 'text' }, ...cli },
  })

  // A catalogue command with nowhere to read the entries or the id would fail on
  // the first picker refresh instead of here.
  assert.throws(
    () => assertCliRecipe('x', profile({ catalogCommand: ['vendor', 'models'] })),
    /cli\.catalogCommand without cli\.catalogJson\.entries and cli\.catalogJson\.id/,
  )
  assert.throws(
    () => assertCliRecipe('x', profile({ catalogJson: { entries: 'models' } })),
    /cli\.catalogJson without cli\.catalogCommand/,
  )
  assert.throws(
    () => assertCliRecipe('x', profile({ catalogTimeoutMs: 5_000 })),
    /cli\.catalogTimeoutMs without cli\.catalogCommand/,
  )
  // Disjoint cache counts are only meaningful beside the uncached input/output.
  assert.throws(
    () => assertCliRecipe('x', profile({ jsonl: { text: 'text', usage: { cacheRead: 'usage.read' } } })),
    /cache paths without cli\.jsonl\.usage\.input and cli\.jsonl\.usage\.output/,
  )

  // The schema materializes `catalogJson: {}` on every cli entry; emptiness must
  // not read as "configured a mapping but no command".
  const plain = resolveAgent('x', parse({
    agents: { x: { transport: 'cli', command: 'vendor', format: 'jsonl', cli: { promptVia: 'arg', jsonl: { text: 'text' } } } },
  }).agents.get().x)
  assert.equal('catalogJson' in plain.cli, false)
  assert.doesNotThrow(() => assertCliRecipe('x', plain))
  assert.equal(plain.cli.promptVia, 'arg', 'an explicit promptVia is kept')
})
