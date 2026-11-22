/**
 * Drive the Claude Code and Codex presets through the plugin's own path.
 *
 * Reports what a user with no stored credential actually experiences: the
 * capabilities, the catalogue (or its fallback), and the first-turn error.
 */
import { readFileSync } from 'node:fs'
import { resolveAgent } from '../lib/config.js'
import { createTransport } from '../lib/transport/index.js'

function storedCredentials() {
  const text = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  const found = new Map()
  for (const match of text.matchAll(/^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/gm)) found.set(match[1], match[2])
  return found
}

const credentials = storedCredentials()
// The environment wins, which is also how a user would try a key by hand.
const resolve = async (ref) => process.env[ref] ?? credentials.get(ref)

for (const preset of process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['claude-code', 'codex']) {
  console.log(`\n${'='.repeat(70)}\n### ${preset}`)
  // Short bounds: a wrong key makes an agent retry for minutes before it gives up.
  const profile = resolveAgent(preset, { preset, connectTimeoutMs: 45_000, eventTimeoutMs: 45_000 })
  console.log('command:', profile.command, profile.args.join(' '))
  let transport
  try {
    transport = await createTransport(profile, {
      cwd: '/root/workspace',
      credentials: { resolve },
      resolveExecutable: async (command) => command,
      logger: { error: (message) => console.log('  LOG:', message) },
    })
    console.log('capabilities:', [...transport.capabilities].sort().join(', '))
    console.log('auth methods:', transport.authMethods.join(', ') || '(none)')

    const catalog = await transport.catalog()
    console.log('catalogue:', catalog.length === 0 ? '(empty)' : catalog.map((entry) => entry.id).join(', '))

    const session = await transport.create()
    const target = catalog[0]?.id ?? 'default'
    await session.selectModel(target)
    console.log('selected model:', target)
    const outcome = await session.prompt({ text: 'Reply with exactly: OK' })
    console.log('answer:', JSON.stringify(outcome.text ?? '').slice(0, 120), '| stop:', outcome.stopReason)
  } catch (error) {
    console.log('FIRST-TURN ERROR:', error.message.replace(/\s+/g, ' ').slice(0, 300))
  } finally {
    await transport?.close('probe done')
  }
}
