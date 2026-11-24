/** Bounded, serialized and sanitized launch diagnostics. */
import { appendFile, mkdir, stat, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { redactValue, redactArgs } from './redact.js'
const MAX_BYTES = 256 * 1024
export class LaunchDiagnostics {
  constructor(profileDir, options = {}) {
    this.path = join(profileDir, 'agent-providers', 'launch.log')
    this.maxBytes = options.maxBytes ?? MAX_BYTES
    this.writes = Promise.resolve()
  }
  record(record) {
    const safe = redactValue(record)
    if (record.args) safe.args = redactArgs(record.args)
    let line = `${JSON.stringify({ at: new Date().toISOString(), ...safe })}\n`
    if (Buffer.byteLength(line) > this.maxBytes / 2) line = `${JSON.stringify({ at: new Date().toISOString(), route: safe.route, error: String(safe.error ?? '').slice(0, 512), truncated: true })}\n`
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const size = await stat(this.path).then(row => row.size, error => { if (error.code === 'ENOENT') return 0; throw error })
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await rm(`${this.path}.1`, { force: true })
        await rename(this.path, `${this.path}.1`).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      await appendFile(this.path, line, { mode: 0o600 })
    }).catch(() => {})
    return this.writes
  }
}
