#!/usr/bin/env node
/** Isolated real DSH smoke test with a synthetic ACP process; no credentials or model calls. */
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-smoke-'))
const host = process.env.DSH_TEST_BIN
if (!host) throw new Error('set DSH_TEST_BIN to the compatible dsh lib/bin.js path')
const profile = join(root, 'home', 'profiles', 'headless')
const env = { ...process.env, DSH_HOME: join(root, 'home') }
const run = (args) => spawnSync(process.execPath, [host, ...args], { env, cwd: root, encoding: 'utf8', timeout: 60000 })
try {
  const init = run(['--profile', 'headless', '--dump-config'])
  if (init.status !== 0) throw new Error(init.stderr)
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await symlink(repo, join(profile, 'node_modules', 'dsh-agent-providers'), 'dir')
  await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: llm-agent-providers\n      name: dsh-agent-providers\n      config:\n        exposeTool: false\n        agents:\n          fixture:\n            command: ${JSON.stringify(process.execPath)}\n            args: [${JSON.stringify(join(repo, 'test/fake-agent.mjs'))}]\n            permission: reject\n            models: [{ id: fake/opus }]\n- id: agent-default-model\n  config:\n    provider: fixture\n    model: fake/opus\n`)
  const result = run(['--profile', 'headless', '--json', 'Reply with a short greeting'])
  console.log(JSON.stringify({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2))
  const candidates = [join(profile, 'agent-providers/activity.json'), join(root, 'home/agent-providers/agent-providers/activity.json'), join(root, 'agent-providers/agent-providers/activity.json')]
  let activity
  for (const path of candidates) { try { activity = JSON.parse(await readFile(path, 'utf8')); console.log(`activity: ${path}`); break } catch {} }
  if (result.status !== 0 || !activity?.runs.some(row => row.status === 'completed')) throw new Error('DSH smoke did not complete')
  console.log('REAL_DSH_SMOKE_OK')
} finally { await rm(root, { recursive: true, force: true }) }
