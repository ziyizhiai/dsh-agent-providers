/** Print every ACP update type one turn emits, with usage_update payloads. */
import { readFileSync } from 'node:fs'
import { resolveAgent } from '../lib/config.js'
import { createTransport } from '../lib/transport/index.js'

function credential(ref) {
  const t = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  return new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm').exec(t)[1]
}
const profile = resolveAgent('oc', { preset: 'opencode', command: '/usr/local/bin/opencode', env: { OPENCODE_DISABLE_AUTOUPDATE: '1' } })
const transport = await createTransport(profile, {
  cwd: '/root',
  credentials: { resolve: async (ref) => credential(ref) },
  resolveExecutable: async (c) => c,
  logger: { error: () => {} },
})
const model = process.argv[2] ?? 'opencode-go/deepseek-v4.1-flash'
const session = await transport.create({ cwd: '/root' })
await session.selectModel(model)
const outcome = await session.prompt({ text: 'Reply with exactly: OK', onUpdate: (e) => {
  if (e.type === 'raw') return
  if (e.type === 'context') console.log('CONTEXT UPDATE:', JSON.stringify(e))
  else if (e.type !== 'text' && e.type !== 'reasoning') console.log('event:', e.type, JSON.stringify(e).slice(0, 160))
} })
console.log('model:', model, '| outcome usage:', JSON.stringify(outcome.usage))
await session.close(); await transport.close('done')
