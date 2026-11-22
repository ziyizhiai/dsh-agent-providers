/**
 * Live fork: real OpenCode, real ACP `session/fork`, real rebind.
 *
 * Uses a throwaway registry so the harness's own bindings are untouched.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgent } from '../lib/config.js'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { SessionRegistry } from '../lib/registry.js'
import { SessionAdmin } from '../lib/sessions.js'

const MODEL = process.argv[2] ?? 'opencode-go/deepseek-v4.1-flash'
const CWD = '/root/workspace'

function credential(ref) {
  const text = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  return new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text)[1]
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-fork-'))
const profile = resolveAgent('oc', {
  preset: 'opencode',
  command: '/usr/local/bin/opencode',
  env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
})
const profiles = new Map([['oc', profile]])
const registry = new SessionRegistry(dir)
const adapter = new AgentProviderAdapter({
  current: () => ({ profiles, maxReplayChars: 400_000 }),
  registry,
  resolveCwd: () => CWD,
  credentials: { resolve: async (ref) => credential(ref) },
  readImage: async () => ({ data: new Uint8Array([1]) }),
  logger: { error: (message) => console.log('LOG:', message) },
})
const admin = new SessionAdmin({
  adapter,
  current: () => ({ profiles }),
  registry,
  resolveCwd: () => CWD,
  logger: { error: () => {} },
})

const DSH = 'session-fork-probe'
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
async function turn(messages) {
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'oc', model: MODEL, sessionId: DSH, messages })) {
    chunks.push(chunk)
  }
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

try {
  console.log('turn 1:', (await turn([user('Say exactly: one')])).trim())
  const original = await registry.get(DSH, 'oc')
  console.log('bound to:', original.externalSessionId)

  const forked = await admin.fork({ route: 'oc', dshSessionId: DSH })
  console.log('fork:', forked.from, '→', forked.to)
  const rebound = await registry.get(DSH, 'oc')
  console.log('rebound to:', rebound.externalSessionId, '| witnesses kept:',
    rebound.sentUserCount === original.sentUserCount && rebound.sentUserDigest === original.sentUserDigest)

  const inventory = await admin.list('oc')
  const ids = inventory.sessions.map((session) => session.sessionId)
  console.log('both present in the agent store:', ids.includes(forked.from) && ids.includes(forked.to))

  // The branch inherits the history, so the next turn continues on it.
  const answer = await turn([user('Say exactly: one'), { role: 'assistant', content: [{ type: 'text', text: 'one' }] }, user('Say exactly: two')])
  console.log('turn 2 on the branch:', answer.trim())
  const after = await registry.get(DSH, 'oc')
  console.log('still on the branch:', after.externalSessionId === forked.to)

  await admin.close('oc', forked.to)
  console.log('branch closed')
} catch (error) {
  console.log('PROBE ERROR:', error.message)
} finally {
  await adapter.dispose()
  await rm(dir, { recursive: true, force: true })
}
