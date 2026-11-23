/**
 * Drive one REAL turn against the installed TRAE CLI (`traex`) through this
 * package's transport, and print what the harness would see.
 *
 * Usage: node probe/probe-traex.mjs [modelId] [promptText] [cwd]
 *
 * It needs no credential of ours: the `traex` preset maps none on purpose and
 * the CLI signs in through its own store (`~/.trae/traecli.toml`), which is the
 * whole point of reusing an interactive login. Its four session config options
 * (`mode`, `collaboration_mode`, `model`, `reasoning_effort`) are printed with
 * the per-model context window the agent carries in `_meta.trae.contextWindow`.
 */
import { resolveAgent } from '../lib/config.js'
import { createTransport } from '../lib/transport/index.js'

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash'
const PROMPT = process.argv[3] ?? 'Reply with exactly: OK'
const CWD = process.argv[4] ?? process.cwd()

const started = Date.now()
const mark = (label) => console.log(`[+${Date.now() - started}ms] ${label}`)
const windowOf = (value) => value?._meta?.trae?.contextWindow

const profile = resolveAgent('traex', { preset: 'traex' })
console.log('profile:', JSON.stringify({
  route: profile.route,
  command: profile.command,
  args: profile.args,
  inputTokensIncludeCache: profile.inputTokensIncludeCache,
  permission: profile.permission,
  continuity: profile.continuity,
}))

const transport = await createTransport(profile, {
  cwd: CWD,
  credentials: { resolve: async () => undefined },
  resolveExecutable: async (command) => command,
  diagnostics: { record: async (record) => console.log('LAUNCH DIAGNOSTIC:', JSON.stringify(record)) },
  logger: { error: (message) => console.log('LOG:', message) },
})

try {
  mark(`transport ${transport.kind} ready: ${[...transport.capabilities].sort().join(', ')}`)
  // `lib/transport/acp.js` normalizes these to ids today; accept the raw
  // `{id, name}` objects too so the probe survives that layer changing.
  console.log('authMethods:', (transport.authMethods ?? [])
    .map((method) => (typeof method === 'string' ? method : method?.id ?? method?.name ?? String(method)))
    .join(', ') || '(none)')

  const catalog = await transport.catalog({ cwd: CWD })
  mark(`catalogue: ${catalog.length} models`)
  for (const model of catalog) console.log(`  ${model.id} — ${model.name}`)
  if (!catalog.some((model) => model.id === MODEL)) {
    throw new Error(`model ${MODEL} is not in the catalogue`)
  }

  const session = await transport.create({ cwd: CWD })
  mark(`session ${session.externalId} (resumed=${session.resumed})`)
  // The raw options, not the normalized catalogue: only here does each model
  // carry its own measured window, and only here are the non-model selects
  // (`mode`, `reasoning_effort`) visible at all.
  for (const option of session.configOptions ?? []) {
    const values = Array.isArray(option.options) ? option.options : []
    console.log(`configOption ${option.id} (${option.category ?? 'no category'}, ${option.type}): current=${JSON.stringify(option.currentValue)}, ${values.length} values`)
    if (option.id === 'model') {
      for (const value of values) {
        console.log(`  - ${value.value} (${value.name ?? '?'}) contextWindow=${windowOf(value) ?? 'not advertised'}`)
      }
    } else {
      console.log(`  ${values.map((value) => value.value ?? value).join(', ')}`)
    }
  }

  await session.selectModel(MODEL)
  mark(`model selected: ${MODEL}`)

  let text = ''
  let thoughts = 0
  const tools = []
  const contexts = []
  const outcome = await session.prompt({
    text: PROMPT,
    onUpdate: (event) => {
      if (event.type === 'text') {
        if (text.length === 0) mark('first text delta')
        text += event.text
      } else if (event.type === 'reasoning') {
        if (thoughts === 0) mark('first reasoning delta')
        thoughts += 1
      } else if (event.type === 'tool') {
        tools.push(`${event.status} ${event.title}`)
        mark(`tool: ${event.status} ${event.title}`)
      } else if (event.type === 'context') {
        // The agent's own `{used, size}`; the adapter learns `size` as the
        // model's window, which is how the harness stops guessing.
        contexts.push(event)
        mark(`context: used=${event.used} size=${event.size}`)
      }
    },
  })

  mark(`turn finished: stopReason=${outcome.stopReason}`)
  console.log('--- answer ---')
  console.log(text.trim().slice(0, 800))
  console.log('--- stats ---')
  console.log(`reasoning deltas: ${thoughts}, tool events: ${tools.length}, context updates: ${contexts.length}`)
  if (tools.length > 0) console.log('tools:', tools.join(' | '))
  console.log('usage:', JSON.stringify(outcome.usage))
  if (outcome.usage !== undefined) {
    // Proof the counts are disjoint when the profile says so: the raw ACP
    // `inputTokens` folds the cache in, so the parts must add back up.
    const { inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = outcome.usage
    console.log(`disjoint check: input ${inputTokens} + cacheRead ${cacheReadTokens} + cacheWrite ${cacheWriteTokens} = ${inputTokens + cacheReadTokens + cacheWriteTokens}`)
  }
  await session.close()
} finally {
  await transport.close('probe finished')
}
