/**
 * Is `PromptResponse.usage` per-turn or cumulative for the agent session?
 *
 * Runs two turns in ONE session and prints each reported usage. If the second
 * report is roughly the sum, the harness must differentiate; if it is a fresh
 * per-turn count, reporting it directly is correct.
 */
import { readFileSync } from 'node:fs'
import { resolveAgent } from '../lib/config.js'
import { createTransport } from '../lib/transport/index.js'

function credential(ref) {
  const text = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  return new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text)[1]
}

const profile = resolveAgent('oc', {
  preset: 'opencode',
  command: '/usr/local/bin/opencode',
  env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
})
const transport = await createTransport(profile, {
  cwd: '/root',
  credentials: { resolve: async (ref) => credential(ref) },
  resolveExecutable: async (c) => c,
  logger: { error: () => {} },
})

try {
  const model = process.argv[2] ?? 'opencode-go/deepseek-v4.1-flash'
  const session = await transport.create({ cwd: '/root' })
  await session.selectModel(model)

  for (const [index, text] of ['Say exactly: one', 'Say exactly: two', 'Say exactly: three'].entries()) {
    const outcome = await session.prompt({ text })
    console.log(`turn ${index + 1}:`, JSON.stringify(outcome.usage))
  }
  await session.close()
} finally {
  await transport.close('probe finished')
}
