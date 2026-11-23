#!/usr/bin/env node
/**
 * probe-dsh-headless.mjs — drive the `traex` preset through a REAL DSH profile
 * end to end, headless, without ever touching the user's DSH home or TRAE login.
 *
 * What it does, in order:
 *   1. makes a throwaway `DSH_HOME` under the OS temp dir;
 *   2. lets `dsh --profile headless --dump-config` initialise that profile from
 *      the shipped template, then rewrites the profile's `cordis.patch.yml` to
 *      mount this repo as `dsh-agent-providers` with one `trae`/`traex` route
 *      and point `agent-default-model` at it;
 *   3. symlinks this checkout into `<profile>/node_modules/dsh-agent-providers`
 *      so the loader resolves the package by name;
 *   4. writes a tiny answerer plugin (an `approval/request` listener that grants
 *      `'allowed-once'`) and a `--patch` overlay that mounts it, then runs one
 *      task and prints every `--json` event with arrival timings.
 *
 * The plugin row itself needs nothing special: `engines.dsh` covers the
 * installed runtime, and the plugin attaches the optional services it uses
 * (`agents`, `approval`, …) through `ctx.inject` on its own.
 *
 * Usage:
 *   node probe/probe-dsh-headless.mjs                       # write-a-file task
 *   node probe/probe-dsh-headless.mjs --task "Reply with exactly: OK"
 *   node probe/probe-dsh-headless.mjs --model gpt-6.1-sol --task "hi"
 *   node probe/probe-dsh-headless.mjs --no-approver         # prove fail-closed
 *   node probe/probe-dsh-headless.mjs --keep                # keep temp home
 *
 * Exit code: the headless run's own exit code (0 = turn completed).
 *
 * It never reads or writes `~/.dsh` or `~/.trae`: `DSH_HOME` is always the temp
 * dir, and the child keeps HOME so TRAE CLI reuses the caller's existing login
 * (that is the point of the preset). Nothing here can mutate that login.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const profileName = flag('profile', 'headless')
const model = flag('model', 'deepseek-v4.1-flash')
const task = flag('task', 'Create a file named hello.txt in the current working directory containing exactly: hello-from-traex. Then reply with just: DONE')
const expectedFile = flag('expect-file', 'hello.txt')
const answerer = !has('no-approver')

const root = mkdtempSync(join(tmpdir(), 'dsh-headless-probe-'))
const home = join(root, 'home')
const profile = join(home, 'profiles', profileName)
const scratch = join(root, 'scratch')
const env = { ...process.env, DSH_HOME: home }
mkdirSync(scratch, { recursive: true })

// 1. Shipped template init: dump-config creates the profile and exits before mounting.
try {
  execFileSync('dsh', ['--profile', profileName, '--dump-config'], { env, cwd: scratch, stdio: 'pipe' })
} catch (error) {
  process.stderr.write(`probe: ${profileName} profile init failed: ${error.message}\n`)
  process.exit(2)
}

// 2. Profile layer: the provider row plus the default model route.
writeFileSync(join(profile, 'cordis.patch.yml'), `# written by probe/probe-dsh-headless.mjs
- insert:
    - id: llm-agent-providers
      name: dsh-agent-providers
      config:
        agents:
          trae:
            preset: traex
- id: agent-default-model
  config:
    provider: trae
    model: ${model}
`)

// 3. Resolvable by package name. No version exemption is written: the plugin's
//    `engines.dsh` covers the installed runtime, so the row must mount on its own.
mkdirSync(join(profile, 'node_modules'), { recursive: true })
const linked = join(profile, 'node_modules', 'dsh-agent-providers')
if (!existsSync(linked)) symlinkSync(repo, linked, 'dir')

// 4. Answerer overlay: only the listener, mounted with `--patch`. The provider
//    row is NOT patched here — it must resolve `agents`/`approval` by itself.
const overlays = []
if (answerer) {
  const listener = join(root, 'auto-approve.mjs')
  writeFileSync(listener, `export const name = 'probe-auto-approve'
export function apply(ctx) {
  ctx.on('approval/request', (request, next) => {
    process.stderr.write('[probe] approval/request ' + JSON.stringify(request.toolName) + ' -> allowed-once\\n')
    return 'allowed-once'
  })
}
`)
  const overlay = join(root, 'answerer.yml')
  writeFileSync(overlay, `- insert:
    - id: probe-auto-approve
      name: ${listener}
`)
  overlays.push(overlay)
}

// 5. One task, every line timestamped so cold start and first token are visible.
const started = Date.now()
const stamp = () => String(Date.now() - started).padStart(6)
const child = spawn('dsh', [
  '--profile', profileName,
  ...overlays.flatMap((overlay) => ['--patch', overlay]),
  '--json', task,
], { env, cwd: scratch })
const relay = (stream, target) => {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) target.write(`+${stamp()}ms ${line}\n`)
  })
  stream.on('end', () => buffer.length > 0 && target.write(`+${stamp()}ms ${buffer}\n`))
}
relay(child.stdout, process.stdout)
relay(child.stderr, process.stderr)
child.on('exit', (code, signal) => {
  process.stdout.write(`+${stamp()}ms [exit=${code} signal=${signal}]\n`)
  const written = join(scratch, expectedFile)
  process.stdout.write(`+${stamp()}ms [file] ${written}: ${existsSync(written) ? `present (${readFileSync(written, 'utf8').length} bytes)` : 'MISSING'}\n`)
  if (has('keep')) process.stdout.write(`probe: temp home kept at ${home}\n`)
  else rmSync(root, { recursive: true, force: true })
  process.exitCode = code ?? 1
})
