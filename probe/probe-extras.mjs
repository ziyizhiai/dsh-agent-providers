/**
 * Two live checks through the adapter (not just the transport):
 *
 * 1. A model the plan denies is recorded and gains a warning badge.
 * 2. An image on the current turn reaches the agent, via the adapter's own
 *    attachment plumbing.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgent } from '../lib/config.js'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { SessionRegistry } from '../lib/registry.js'

const DENIED = process.argv[2] ?? 'opencode-go/claude-haiku-5-5'
const VISION = process.argv[3] ?? 'opencode-go/gemini-4-argon'
const IMAGE = '/root/.dsh/attachments/v1/files/73/733ede953bfa392a9b4fd38dd630e8b8f234382dc3cbce19d71c69345f8c6166/scaled_1000210502.jpg'
const CWD = '/root'

function credential(ref) {
  const text = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  return new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text)[1]
}

const dir = await mkdtemp(join(tmpdir(), 'dsh-extras-'))
const profile = resolveAgent('oc', {
  preset: 'opencode',
  command: '/usr/local/bin/opencode',
  defaultContextWindow: 1_000_000,
  env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
})
const profiles = new Map([['oc', profile]])
const registry = new SessionRegistry(dir)
const adapter = new AgentProviderAdapter({
  current: () => ({ profiles, maxReplayChars: 400_000 }),
  registry,
  resolveCwd: () => CWD,
  credentials: { resolve: async (ref) => credential(ref) },
  readImage: async (ref) => ({ data: new Uint8Array(readFileSync(IMAGE)), ref }),
  logger: { error: (message) => console.log('LOG:', message) },
})

const user = (content) => ({ role: 'user', content })

async function run(sessionId, model, messages) {
  let text = ''
  for await (const chunk of adapter.stream({ provider: 'oc', model, sessionId, messages })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

try {
  console.log('--- 1. denied model')
  try {
    await run('session-denied', DENIED, [user([{ type: 'text', text: 'hi' }])])
    console.log('unexpectedly succeeded')
  } catch (error) {
    console.log('turn failed as expected:', error.message.slice(0, 120))
  }
  const models = await adapter.listModels('oc')
  const denied = models.find((model) => model.id === DENIED)
  console.log('catalogue size:', models.length)
  console.log('badge for', DENIED, '→', JSON.stringify(denied?.badge))
  console.log('badge for a healthy model →', JSON.stringify(models.find((m) => m.id === 'opencode-go/deepseek-v4.1-flash')?.badge))

  console.log('--- 2. image through the adapter')
  const answer = await run('session-image', VISION, [user([
    { type: 'text', text: 'What is the large number in the middle-right of the screenshot? Answer in a few words.' },
    {
      type: 'image',
      attachment: { attachmentId: 'probe', mediaType: 'image/jpeg', bytes: 182309, width: 1, height: 1, name: 'shot.jpg' },
    },
  ])])
  console.log('answer:', answer.trim().slice(0, 200))
} finally {
  await adapter.dispose()
  await rm(dir, { recursive: true, force: true })
}
