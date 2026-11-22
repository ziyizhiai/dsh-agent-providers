/**
 * Drive one REAL turn against the installed opencode, straight through this
 * package's transport, and print what the harness would see.
 *
 * Usage: node probe-turn.mjs [modelId] [promptText]
 * Needs the same credential the DSH profile uses, read from $DSH_HOME.
 */
import { readFileSync } from 'node:fs'
import { resolveAgent } from '../lib/config.js'
import { createTransport } from '../lib/transport/index.js'

const MODEL = process.argv[2] ?? 'opencode-go/deepseek-v4.1-flash'
const PROMPT = process.argv[3] ?? 'Reply with exactly: OK'
const CWD = process.argv[4] ?? '/root/workspace'
/** Which child environment name receives the stored key; probes the auth path. */
const ENV_NAME = process.argv[5] ?? 'OPENCODE_API_KEY'

/** Read one credential ref from the DSH credentials document. */
function credential(ref) {
  const text = readFileSync('/root/.dsh/.credentials.yaml', 'utf8')
  const match = new RegExp(`^\\s{2}${ref}:\\s*(\\S+)\\s*$`, 'm').exec(text)
  if (match === null) throw new Error(`credential ${ref} is not stored`)
  return match[1]
}

const profile = resolveAgent('opencode-go', {
  preset: 'opencode',
  command: '/usr/local/bin/opencode',
  connectTimeoutMs: 60_000,
  // No credentials override: use exactly what the preset ships.
  ...(ENV_NAME === 'none' ? { credentials: {} } : {}),
  env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
})

const started = Date.now()
const mark = (label) => console.log(`[+${Date.now() - started}ms] ${label}`)

const transport = await createTransport(profile, {
  cwd: CWD,
  credentials: { resolve: async (ref) => credential(ref) },
  resolveExecutable: async (command) => command,
  diagnostics: { record: async (record) => console.log('LAUNCH DIAGNOSTIC:', JSON.stringify(record)) },
  logger: { error: (message) => console.log('LOG:', message) },
})

try {
  mark(`transport ${transport.kind} capabilities: ${[...transport.capabilities].sort().join(', ')}`)

  const childEnv = transport.profile.env
  console.log('child env names:', Object.keys(childEnv).sort().join(', '))
  for (const [name, value] of Object.entries(childEnv)) {
    const looksTemplated = value.includes('[object Object]') || value.includes('{value}')
    console.log(`  ${name}: ${value.length} chars${looksTemplated ? ' ← TEMPLATE NOT APPLIED' : ''}`)
  }

  const catalog = await transport.catalog({ cwd: CWD })
  const go = catalog.filter((model) => model.id.startsWith('opencode-go/'))
  mark(`catalog: ${catalog.length} models, ${go.length} on the Go plan`)
  if (!catalog.some((model) => model.id === MODEL)) {
    throw new Error(`model ${MODEL} is not in the catalogue`)
  }

  const session = await transport.create({ cwd: CWD })
  mark(`session ${session.externalId} (resumed=${session.resumed})`)

  await session.selectModel(MODEL)
  mark(`model selected: ${MODEL}`)

  let text = ''
  let thoughts = 0
  let tools = 0
  const outcome = await session.prompt({
    text: PROMPT,
    onUpdate: (event) => {
      if (event.type === 'text') {
        if (text.length === 0) mark('first text delta')
        text += event.text
      } else if (event.type === 'reasoning') {
        thoughts += 1
      } else if (event.type === 'tool') {
        tools += 1
        mark(`tool: ${event.status} ${event.title}`)
      }
    },
  })

  mark(`turn finished: stopReason=${outcome.stopReason}`)
  console.log('--- answer ---')
  console.log(text.trim().slice(0, 800))
  console.log('--- stats ---')
  console.log(`thought events: ${thoughts}, tool events: ${tools}`)
  console.log('usage:', JSON.stringify(outcome.usage))
  await session.close()
} finally {
  await transport.close('probe finished')
}
