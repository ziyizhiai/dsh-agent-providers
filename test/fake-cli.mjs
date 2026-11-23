/**
 * A fake headless coding CLI: reads one prompt, prints JSON lines, exits.
 *
 * Stands in for any agent without ACP support (opencode `run`, a vendor CLI,
 * a future trae command). Its only job is to prove the `cli` transport and the
 * recipe language work end to end.
 *
 * Flags: `--resume <id>`, `--model <id>`, `--catalog-models`.
 * `FAKE_CLI_MODE=refusal` reports a refusal; `FAKE_CLI_MODE=crash` exits 3.
 * `FAKE_CLI_PROMPTS=<path>` appends one JSON line per invocation.
 *
 * `--catalog-models` prints a catalogue document instead of running a turn, the
 * way a launcher enumerates its gateway models: `FAKE_CLI_CATALOG_MODE=error`
 * exits 2 with stderr, `=sleep` stalls past a catalogue timeout, `=stubborn`
 * ignores SIGTERM to prove the timeout escalates, and
 * `FAKE_CLI_CATALOG_PAYLOAD` replaces the document.
 */
import { appendFileSync, writeSync } from 'node:fs'

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const resumed = flagValue('--resume')
const model = flagValue('--model') ?? 'default'

// Catalogue mode stands in for `aiden x models --json`: a launcher that prints
// its model list and exits instead of running a turn. It is handled before
// stdin, because such an enumerator never reads a prompt.
if (argv.includes('--catalog-models')) {
  const mode = process.env.FAKE_CLI_CATALOG_MODE ?? 'ok'
  if (mode === 'error') {
    writeSync(2, 'fake-cli: catalogue fetch exploded\n')
    process.exit(2)
  }
  if (mode === 'sleep') {
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    process.exit(0)
  }
  if (mode === 'stubborn') {
    // A launcher that traps the timeout's SIGTERM, so only an escalation to
    // SIGKILL can end it; without one this exits by itself after five seconds.
    process.on('SIGTERM', () => {})
    await new Promise((resolve) => setTimeout(resolve, 5_000))
    process.exit(0)
  }
  // The payload override exists so a test can prove the *transport* decides
  // what counts as a usable entry (duplicates, non-string ids, banner noise).
  const payload = process.env.FAKE_CLI_CATALOG_PAYLOAD
    ?? '{"models":[{"id":"fast","context_length":64000},{"id":"deep","context_length":200000}]}'
  writeSync(1, `${payload}\n`)
  process.exit(0)
}

let prompt = ''
if (process.stdin.isTTY !== true) {
  prompt = await new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { text += chunk })
    process.stdin.on('end', () => resolve(text))
  })
}

const sessionId = resumed ?? `ses-${Math.random().toString(36).slice(2, 10)}`

if (process.env.FAKE_CLI_PROMPTS !== undefined) {
  appendFileSync(process.env.FAKE_CLI_PROMPTS, `${JSON.stringify({ sessionId, model, prompt })}\n`)
}

const emit = (event) => process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...event })}\n`)

if (process.env.FAKE_CLI_MODE === 'refusal') {
  emit({ is_error: true })
  emit({ message: { content: 'I cannot help with that.' } })
  process.exit(0)
}

if (process.env.FAKE_CLI_MODE === 'crash') {
  process.stderr.write('fake-cli: exploded while planning\n')
  process.exit(3)
}

if (process.env.FAKE_CLI_DUMP_ENV === '1') {
  // Carry the dump through the recipe's own text path so a transport that only
  // reads `message.content` still surfaces it.
  emit({ message: { content: JSON.stringify({
    env_keys: Object.keys(process.env).sort(),
    env_sample: process.env.OPENCODE_AUTH_CONTENT ?? null,
  }) } })
}

emit({ message: { reasoning: 'pondering the request' } })
emit({ message: { tool: 'Read src/a.ts' } })
emit({ message: { content: `done(${model}): ${prompt.trim().slice(0, 40)}` } })
emit({ usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 300, cache_creation_input_tokens: 20 } })
