/**
 * Session administration: inventory, fork-and-rebind, close, delete.
 *
 * Driven by the same real ACP agent the transport tests use.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { resolveAgent } from '../lib/config.js'
import { SessionRegistry } from '../lib/registry.js'
import { SessionAdmin, SessionAdminError } from '../lib/sessions.js'
import { createTransport } from '../lib/transport/index.js'

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))

let dir
let prompts
const built = []

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-sessions-'))
  prompts = join(dir, 'prompts.jsonl')
})

after(() => { delete process.env.FAKE_ACP_PROMPTS })

after(async () => {
  for (const { adapter } of built) await adapter.dispose()
  await rm(dir, { recursive: true, force: true })
})

/** One adapter + admin over the fake ACP route. */
function makeAdmin(overrides = {}) {
  const profile = resolveAgent('fake', {
    displayName: 'Fake Agent',
    command: process.execPath,
    args: [AGENT],
    idleReleaseMs: 60_000,
    models: [{ id: 'fake/opus', name: 'Fake Opus' }],
    ...overrides,
  })
  const registry = new SessionRegistry(dir)
  const adapter = new AgentProviderAdapter({
    current: () => ({ profiles: new Map([['fake', profile]]), maxReplayChars: 100_000 }),
    registry,
    resolveCwd: () => dir,
    credentials: { resolve: async () => ({ value: 'secret' }) },
    logger: { error: () => {} },
  })
  // Set before any spawn: the fake agent reads it at startup.
  process.env.FAKE_ACP_PROMPTS = prompts
  const admin = new SessionAdmin({
    adapter,
    current: () => ({ profiles: new Map([['fake', profile]]) }),
    registry,
    resolveCwd: () => dir,
    logger: { error: () => {} },
  })
  built.push({ adapter })
  return { adapter, admin, registry, profile }
}

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** Run one turn so a binding exists. */
async function seed(adapter, sid, content = 'hello') {
  const messages = Array.isArray(content) ? content : [user(content)]
  for await (const _chunk of adapter.stream({
    provider: 'fake', model: 'fake/opus', sessionId: sid, messages,
  })) {
    // drain
  }
}

test('lists what the agent stores, with the owning DSH session attached', async () => {
  const { adapter, admin } = makeAdmin()
  const sid = 'session-inv-1'
  await seed(adapter, sid)

  const inventory = await admin.inventory()
  assert.equal(inventory.length, 1)
  const [route] = inventory
  assert.equal(route.route, 'fake')
  assert.equal(route.displayName, 'Fake Agent')
  assert.deepEqual(route.capabilities.sort(), ['cancel', 'close', 'delete', 'fork', 'images', 'list', 'resume', 'stream'])
  assert.equal(route.sessions.length, 1)
  assert.equal(route.sessions[0].sessionId, 'fake-session-1')
  assert.equal(route.sessions[0].dshSessionId, sid, 'the inventory names the owning DSH Session')
  assert.equal(typeof route.sessions[0].title, 'string')
})

test('a route whose agent is unreachable reports an error instead of failing the listing', async () => {
  const { admin } = makeAdmin()
  const broken = new SessionAdmin({
    adapter: admin.adapter,
    current: () => ({ profiles: new Map([['fake', { ...admin.current().profiles.get('fake'), command: '/nonexistent/agent' }]]) }),
    registry: admin.registry,
    resolveCwd: () => dir,
    logger: { error: () => {} },
  })
  const inventory = await broken.inventory()
  assert.equal(inventory.length, 1)
  assert.equal(inventory[0].sessions.length, 0)
  assert.match(inventory[0].error, /cannot start|exited with code|failed/)
})

test('forking rebinds the conversation to the branch', async () => {
  const { adapter, admin, registry } = makeAdmin()
  const sid = 'session-fork-1'
  await seed(adapter, sid)
  const before = await registry.get(sid, 'fake')

  const result = await admin.fork({ route: 'fake', dshSessionId: sid, cwd: dir })
  assert.equal(result.from, before.externalSessionId)
  assert.notEqual(result.to, before.externalSessionId)

  const afterBinding = await registry.get(sid, 'fake')
  assert.equal(afterBinding.externalSessionId, result.to)
  assert.equal(afterBinding.sentUserCount, before.sentUserCount, 'the branch inherits the forwarded-turn witness')
  assert.equal(afterBinding.sentUserDigest, before.sentUserDigest)

  // The next turn continues on the branch, not the original.
  // The second turn must keep the same user-turn prefix for the binding to
  // still validate; only then does it resume on the branch.
  const firstLog = (await readFile(prompts, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1)
  const answer = `Echo: ${firstLog.text.slice(0, 60)}`
  await rm(prompts, { force: true })
  await seed(adapter, sid, [user('hello'), { role: 'assistant', content: [{ type: 'text', text: answer }] }, user('second')])
  const logged = (await readFile(prompts, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(logged[0].sessionId, result.to, 'the next turn continues on the branch')
})

test('forking without an agent session explains itself', async () => {
  const { admin } = makeAdmin()
  await assert.rejects(
    admin.fork({ route: 'fake', dshSessionId: 'session-never-used', cwd: dir }),
    (error) => error instanceof SessionAdminError && error.code === 'NO_BINDING',
  )
})

test('closing releases the session and forgets its binding', async () => {
  const { adapter, admin, registry } = makeAdmin()
  const sid = 'session-close-1'
  await seed(adapter, sid)
  const binding = await registry.get(sid, 'fake')

  const result = await admin.close('fake', binding.externalSessionId)
  assert.equal(result.closed, true)
  assert.equal(await registry.get(sid, 'fake'), undefined, 'the binding is dropped')
})

test('deleting removes the session from the agent store', async () => {
  const { adapter, admin, registry } = makeAdmin()
  const sid = 'session-delete-1'
  await seed(adapter, sid)
  const binding = await registry.get(sid, 'fake')

  const result = await admin.delete('fake', binding.externalSessionId)
  assert.equal(result.deleted, true)
  assert.equal(await registry.get(sid, 'fake'), undefined)

  const inventory = await admin.list('fake')
  assert.equal(
    inventory.sessions.some((session) => session.sessionId === binding.externalSessionId),
    false,
    'the deleted session is gone from the agent inventory',
  )
})

test('an unknown route names the configured ones', async () => {
  const { admin } = makeAdmin()
  await assert.rejects(
    admin.list('nope'),
    /unknown agent route "nope" \(configured: fake\)/,
  )
})

test('a backend without fork support refuses instead of pretending', async () => {
  const { adapter, admin, registry } = makeAdmin()
  const sid = 'session-nofork-1'
  await seed(adapter, sid)
  const profile = admin.current().profiles.get('fake')
  const transport = await adapter.transportFor(profile, dir)
  transport.capabilities.delete('fork')
  try {
    await assert.rejects(
      admin.fork({ route: 'fake', dshSessionId: sid, cwd: dir }),
      /cannot fork sessions/,
    )
    // The binding is untouched, so the conversation keeps working.
    assert.notEqual(await registry.get(sid, 'fake'), undefined)
  } finally {
    transport.capabilities.add('fork')
  }
})

test('a templated credential reaches the child as the agent expects it', async () => {
  // The CLI transport spawns per turn, so a fake CLI that echoes its env is the
  // cheapest way to observe exactly what the child receives.
  const cli = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url))
  const profile = resolveAgent('templated', {
    transport: 'cli',
    format: 'jsonl',
    command: process.execPath,
    args: [cli],
    models: [{ id: 'm', name: 'M' }],
    credentials: {
      PLAIN_VAR: 'PLAIN_REF',
      DOC_VAR: { ref: 'DOC_REF', template: '{"opencode-go":{"type":"api","key":"{value}"}}' },
    },
    cli: { promptVia: 'stdin', jsonl: { text: 'message.content' } },
  })
  const transport = await createTransport(profile, {
    cwd: dir,
    credentials: {
      async resolve(ref) {
        if (ref === 'PLAIN_REF') return 'plain-secret'
        if (ref === 'DOC_REF') return 'doc-secret'
        return undefined
      },
    },
    resolveExecutable: async (command) => command,
  })
  const env = transport.profile.env
  assert.equal(env.PLAIN_VAR, 'plain-secret')
  assert.equal(env.DOC_VAR, '{"opencode-go":{"type":"api","key":"doc-secret"}}')
  await transport.close()
})

test('a missing credential ref names itself before anything spawns', async () => {
  const profile = resolveAgent('missing', {
    transport: 'cli',
    command: process.execPath,
    models: [{ id: 'm', name: 'M' }],
    credentials: { DOC_VAR: { ref: 'NOPE', template: '{value}' } },
    cli: { promptVia: 'stdin', jsonl: { text: 'message.content' } },
  })
  await assert.rejects(
    createTransport(profile, {
      cwd: dir,
      credentials: { resolve: async () => undefined },
      resolveExecutable: async (command) => command,
    }),
    /needs credential "NOPE" for DOC_VAR/,
  )
})
