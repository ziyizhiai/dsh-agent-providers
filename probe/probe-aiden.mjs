/**
 * Drive one REAL turn against the company-internal Aiden launcher
 * (`aiden x claude`) through the `cli` transport, and print what the harness
 * would see.
 *
 * Usage: node probe/probe-aiden.mjs [modelId] [promptText] [cwd]
 *
 * Requirements, because this probe spends the company gateway rather than a
 * local mock:
 *
 * - A logged-in `aiden` (ByteCloud). Aiden keeps its own token store under
 *   `$HOME`; with `HOME` intact it reuses that login and needs no env token.
 *   The child environment is scrubbed of `KEY` / `PASSWORD` / `SECRET` /
 *   `TOKEN`-shaped names and `DSH_*`, but `HOME` survives, which is exactly the
 *   point of letting Aiden own auth. Run it with a writable `HOME` that already
 *   holds that login; a non-interactive run with no cached session fails.
 * - One short model call: the single prompt below. The catalogue is a separate
 *   gateway command (`aiden x models --claude --json`), not part of the turn.
 *
 * `modelId` defaults to the first id in the live catalogue, because the ids are
 * gateway ids (e.g. `ark-deepseek-v4.1-flash-1017`) rather than the aliases the
 * plain `claude` CLI takes. Pass one from a previous run to pin it.
 *
 * The imports are `resolveAgent` + `CliTransport` on purpose: this is the same
 * seam the `aiden-claude` preset ships, with no DSH profile in between, so a
 * failure here is a transport/recipe failure rather than a host one.
 */
import { resolveAgent } from '../lib/config.js'
import { STOP_REASON } from '../lib/transport/contract.js'
import { CliTransport, assertCliRecipe } from '../lib/transport/cli.js'

const MODEL = process.argv[2]
const PROMPT = process.argv[3] ?? 'Reply with exactly: PONG'
const CWD = process.argv[4] ?? process.cwd()

const started = Date.now()
const mark = (label) => console.log(`[+${Date.now() - started}ms] ${label}`)

const profile = resolveAgent('aiden-claude', { preset: 'aiden-claude' })
// The recipe's wiring is validated before anything is spawned, so a broken
// seam (a catalogue command without the paths that read it) fails with the
// load-time message instead of a confusing empty group later.
assertCliRecipe(profile.route, profile)

console.log('profile:', JSON.stringify({
  route: profile.route,
  displayName: profile.displayName,
  command: profile.command,
  args: profile.args,
  catalogCommand: profile.cli?.catalogCommand,
  catalogJson: profile.cli?.catalogJson,
  promptVia: profile.cli?.promptVia,
  resumeArgs: profile.cli?.resumeArgs,
  sessionIdPath: profile.cli?.sessionIdPath,
  continuity: profile.continuity,
  permission: profile.permission,
  declaredModels: profile.models.length,
}))
console.log('home:', process.env.HOME ?? '(unset — Aiden has no token store to read)')

const transport = new CliTransport(profile, CWD, {
  logger: { error: (message) => console.log('LOG:', message) },
})

try {
  mark(`transport ${transport.kind} capabilities: ${[...transport.capabilities].sort().join(', ') || '(none)'}`)

  // Live catalogue from the gateway. The command prints pure JSON on stdout and
  // puts its own progress spinner on stderr, so the transport never has to
  // filter log lines out of the payload.
  const catalog = await transport.catalog({ cwd: CWD })
  mark(`catalogue: ${catalog.length} models (live from the gateway)`)
  for (const model of catalog) {
    // `context_length` from the catalogue is the authoritative window; the
    // generic `modelUsage.contextWindow` in the result event is not.
    console.log(`  ${model.id} — ${model.name} contextWindow=${model.contextWindow ?? 'not advertised'}`)
  }
  if (catalog.length === 0) throw new Error('the catalogue is empty, so there is no model id to select')

  const model = MODEL ?? catalog[0].id
  if (MODEL !== undefined && !catalog.some((entry) => entry.id === MODEL)) {
    throw new Error(`model ${MODEL} is not in the live catalogue`)
  }

  const session = await transport.create({ cwd: CWD })
  mark(`session ${session.externalId} (resumed=${session.resumed})`)
  await session.selectModel(model)
  mark(`model selected: ${model}`)

  let text = ''
  let thoughts = 0
  const tools = []
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
      }
    },
  })

  mark(`turn finished: stopReason=${outcome.stopReason}`)
  // The CLI learns Claude Code's own session id from the event stream; a later
  // turn resumes with it via `--resume <session_id>`.
  console.log(`session id after the turn: ${session.externalId}`)
  console.log('--- answer ---')
  console.log(text.trim().slice(0, 800))
  console.log('--- stats ---')
  console.log(`reasoning deltas: ${thoughts}, tool events: ${tools.length}`)
  if (tools.length > 0) console.log('tools:', tools.join(' | '))
  console.log('usage:', JSON.stringify(outcome.usage))
  if (outcome.usage !== undefined) {
    // Claude Code already reports uncached input next to the cache counters, so
    // the counts are disjoint with no `inputTokensIncludeCache` adjustment.
    const { inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = outcome.usage
    console.log(
      `disjoint check: input ${inputTokens} + cacheRead ${cacheReadTokens} + cacheWrite ${cacheWriteTokens} = ${inputTokens + cacheReadTokens + cacheWriteTokens}`,
    )
  }
  await session.close()
  if (outcome.stopReason !== STOP_REASON.END_TURN) {
    throw new Error(`turn did not finish cleanly: stopReason=${outcome.stopReason}`)
  }
} catch (error) {
  console.error('PROBE FAILED:', error?.message ?? error)
  process.exitCode = 1
} finally {
  await transport.close('probe finished')
}
