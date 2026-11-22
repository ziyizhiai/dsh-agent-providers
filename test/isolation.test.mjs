/** The isolation promises: a scrubbed child environment and a bounded store. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveAgent } from '../lib/config.js'
import { scrubbedParentEnv } from '../lib/env.js'
import { SessionBinding, SessionRegistry } from '../lib/registry.js'
import { createTransport } from '../lib/transport/index.js'

const CLI = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))
let dir

before(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-iso-')) })
after(async () => { await rm(dir, { recursive: true, force: true }) })

test('the child base environment drops credentials and harness identity', () => {
  const env = scrubbedParentEnv({
    PATH: '/bin',
    HOME: '/root',
    LANG: 'C.UTF-8',
    DEEPSEEK_API_KEY: 'secret',
    CUSTOM_OPENCODE_API_KEY: 'secret',
    GITHUB_TOKEN: 'secret',
    DB_PASSWORD: 'secret',
    DSH_HOME: '/root/.dsh',
    DSH_SESSION_ID: 'session-1',
  })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH'])
})

test('a real child sees the scrubbed base plus only what the profile maps', async () => {
  process.env.FAKE_CLI_DUMP_ENV = '1'
  // Poison the parent: this must never reach the agent.
  process.env.DEEPSEEK_API_KEY = 'parent-secret'
  try {
    const profile = resolveAgent('iso', {
      transport: 'cli',
      format: 'jsonl',
      command: process.execPath,
      args: [CLI],
      models: [{ id: 'm', name: 'M' }],
      credentials: { OPENCODE_AUTH_CONTENT: { ref: 'R', template: '{"k":"{value}"}' } },
      cli: { promptVia: 'stdin', jsonl: { text: 'message.content' } },
    })
    const transport = await createTransport(profile, {
      cwd: dir,
      credentials: { resolve: async () => 'mapped-secret' },
      resolveExecutable: async (command) => command,
    })
    const session = await transport.create({ cwd: dir })
    const events = []
    await session.prompt({ text: 'x', onUpdate: (event) => events.push(event) })
    await transport.close()

    const dump = events.find((event) => event.type === 'text' && event.text.includes('"env_keys"'))
    assert.notEqual(dump, undefined, 'the child reported its environment')
    const parsed = JSON.parse(dump.text.trim())
    assert.equal(parsed.env_keys.includes('DEEPSEEK_API_KEY'), false, 'a parent credential never reaches the agent')
    assert.equal(parsed.env_keys.includes('FAKE_CLI_DUMP_ENV'), true, 'an ordinary variable still does')
    assert.equal(parsed.env_sample, '{"k":"mapped-secret"}', 'the profile mapping is forwarded, and only it')
  } finally {
    delete process.env.FAKE_CLI_DUMP_ENV
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('the binding store is bounded and keeps the newest', async () => {
  const registry = new SessionRegistry(dir, { maxBindings: 3 })
  for (let index = 0; index < 5; index += 1) {
    await registry.set(`session-${index}`, 'fake', new SessionBinding({
      externalSessionId: `ext-${index}`,
      cwd: dir,
      sentUserCount: 1,
      sentUserDigest: 'd:1',
      lastPromptAt: index,
    }))
  }
  const rows = await registry.all()
  assert.equal(rows.length, 3, 'older bindings are dropped')
  assert.deepEqual(rows.map((row) => row.dshSessionId).sort(), ['session-2', 'session-3', 'session-4'])
})
