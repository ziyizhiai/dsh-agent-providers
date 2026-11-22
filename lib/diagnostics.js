/**
 * A one-line-per-launch record of a cold start that failed.
 *
 * Cold-start failures are the hardest thing to debug from a browser: the
 * message reaches the model picker and nothing else survives. Recording the
 * launch facts (never environment values, only their names) makes the failure
 * inspectable from the profile directory.
 *
 * @module dsh-agent-providers/diagnostics
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Entries kept before the oldest are dropped. */
const MAX_BYTES = 256 * 1024

export class LaunchDiagnostics {
  /** @param {string} profileDir */
  constructor(profileDir) {
    this.path = join(profileDir, 'agent-providers', 'launch.log')
  }

  /**
   * Append one failure record.
   * @param {object} record
   */
  async record(record) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...record })
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await appendFile(this.path, `${line}\n`, { mode: 0o600 })
    } catch {
      // Diagnostics must never change the outcome of the launch they describe.
    }
  }
}
