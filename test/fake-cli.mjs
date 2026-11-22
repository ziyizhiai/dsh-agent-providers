/**
 * A fake headless coding CLI: reads one prompt, prints JSON lines, exits.
 *
 * Stands in for any agent without ACP support (opencode `run`, a vendor CLI,
 * a future trae command). Its only job is to prove the `cli` transport and the
 * recipe language work end to end.
 *
 * Flags: `--resume <id>`, `--model <id>`.
 * `FAKE_CLI_MODE=refusal` reports a refusal; `FAKE_CLI_MODE=crash` exits 3.
 * `FAKE_CLI_PROMPTS=<path>` appends one JSON line per invocation.
 */
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const resumed = flagValue('--resume')
const model = flagValue('--model') ?? 'default'

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
emit({ usage: { input_tokens: 11, output_tokens: 4 } })
