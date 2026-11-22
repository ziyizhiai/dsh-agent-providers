/**
 * The documented configuration must validate, and the presets must expand to
 * exactly what the README claims.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, resolveAgent } from '../lib/config.js'
import { PRESETS } from '../lib/presets.js'

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
  for (const preset of ['opencode', 'claude-code', 'codex']) {
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
  assert.equal(profile.permission, 'allow')
  assert.equal(profile.continuity, 'auto')
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
  for (const field of ['transport', 'format', 'permission', 'continuity']) {
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
