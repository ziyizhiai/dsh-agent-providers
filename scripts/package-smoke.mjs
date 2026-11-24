#!/usr/bin/env node
/** Validate published contents and all packaged JavaScript syntax. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const repo = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'agent-package-'))
function run(command, args, cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout
}
try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const pack = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', root]))[0]
  for (const required of ['lib/redact.js', 'lib/storage.js', 'lib/activity.js', 'lib/client.js', 'lib/index.js']) assert.ok(pack.files.some(file => file.path === required), `missing ${required}`)
  for (const file of pack.files.filter(file => file.path.endsWith('.js'))) run(process.execPath, ['--check', join(repo, file.path)])
  assert.ok(!pack.files.some(file => file.path.startsWith('test/') || file.path.includes('node_modules')))
  console.log('PACKAGE_SMOKE_OK')
} finally { await rm(root, { recursive: true, force: true }) }
