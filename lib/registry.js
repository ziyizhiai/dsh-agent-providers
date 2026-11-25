/**
 * Durable map from a DSH Session to the external agent session that serves it.
 *
 * The harness Session log is authoritative for the conversation; the external
 * agent's session is authoritative for that agent's own context and tool
 * state; the subprocess is disposable. This registry is the only place the
 * first two meet, so it records enough to prove they still agree.
 *
 * @module dsh-agent-providers/registry
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fingerprint, atomicStoreWrite } from './storage.js'

/** One external session bound to one DSH Session on one provider route. */
export class SessionBinding {
  constructor(record) {
    /** External (agent-side) session id. */
    this.externalSessionId = record.externalSessionId
    /** Absolute cwd the external session was created with. */
    this.cwd = record.cwd
    /** How many user turns had been forwarded when the last prompt settled. */
    this.sentUserCount = record.sentUserCount
    /** Digest of the user-turn prefix that had been forwarded. */
    this.sentUserDigest = record.sentUserDigest ?? record.sentHistoryDigest ?? ''
    /** The model the external session was last set to. */
    this.model = record.model
    /** Unix ms of the last settled prompt. */
    this.lastPromptAt = record.lastPromptAt
    this.sentMessageCount = record.sentMessageCount
    this.sentMessageDigest = record.sentMessageDigest
    this.sentSystemDigest = record.sentSystemDigest
    this.requestedModel = record.requestedModel
    this.forkedFrom = record.forkedFrom
    this.sessionConfig = structuredClone(record.sessionConfig ?? {})
    this.generation = record.generation
    this.configOptions = structuredClone(record.configOptions ?? [])
    this.capabilities = [...(record.capabilities ?? [])]
  }

  toRecord() {
    return {
      externalSessionId: this.externalSessionId,
      cwd: this.cwd,
      sentUserCount: this.sentUserCount,
      sentUserDigest: this.sentUserDigest,
      ...(this.model === undefined ? {} : { model: this.model }),
      lastPromptAt: this.lastPromptAt,
      ...(this.sentMessageCount === undefined ? {} : { sentMessageCount: this.sentMessageCount }),
      ...(this.sentMessageDigest === undefined ? {} : { sentMessageDigest: this.sentMessageDigest }),
      ...(this.sentSystemDigest === undefined ? {} : { sentSystemDigest: this.sentSystemDigest }),
      ...(this.requestedModel === undefined ? {} : { requestedModel: this.requestedModel }),
      ...(this.forkedFrom === undefined ? {} : { forkedFrom: this.forkedFrom }),
      sessionConfig: structuredClone(this.sessionConfig),
      ...(this.generation ? { generation: this.generation } : {}),
      configOptions: structuredClone(this.configOptions), capabilities: [...this.capabilities],
    }
  }
}

/** Process-wide store backed by one JSON file inside the profile directory. */
/** Bindings kept before the oldest are dropped. */
export const DEFAULT_MAX_BINDINGS = 1_000

export class SessionRegistry {
  /**
   * @param {string} profileDir - the active profile directory.
   * @param {{ maxBindings?: number }} [options]
   */
  constructor(profileDir, options = {}) {
    this.path = join(profileDir, 'agent-providers', 'sessions.json')
    // One binding per (DSH Session, route) is cheap, but the file has no other
    // bound: a profile that runs for months would accumulate dead Sessions.
    this.maxBindings = options.maxBindings ?? DEFAULT_MAX_BINDINGS
    /** @type {Map<string, Record<string, SessionBinding>> | undefined} */
    this.data = undefined
    this.diskFingerprint = null
    this.writes = Promise.resolve()
  }

  async load() {
    if (this.data !== undefined) return this.data
    if (this.loading) return this.loading
    this.loading = this.loadOnce().finally(() => { this.loading = undefined })
    return this.loading
  }

  async loadOnce() {
    let parsed
    this.diskFingerprint = await fingerprint(this.path)
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.persistenceError = `Stored bindings unavailable: ${error.message}`
        this.readOnly = true
      }
      parsed = {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.persistenceError = 'sessions.json has an invalid root; old bindings were ignored'
      this.readOnly = true; parsed = {}
    }
    const data = new Map()
    for (const [dshSessionId, byRoute] of Object.entries(parsed)) {
      if (byRoute === null || typeof byRoute !== 'object') continue
      const bindings = Object.create(null)
      for (const [route, record] of Object.entries(byRoute)) {
        if (record === null || typeof record !== 'object') continue
        if (typeof record.externalSessionId !== 'string') continue
        bindings[route] = new SessionBinding({
          ...record,
          externalSessionId: record.externalSessionId,
          cwd: record.cwd ?? '',
          sentUserCount: Number(record.sentUserCount ?? 0),
          sentUserDigest: record.sentUserDigest ?? record.sentHistoryDigest ?? '',
          model: record.model,
          lastPromptAt: Number(record.lastPromptAt ?? 0),
        })
      }
      data.set(dshSessionId, bindings)
    }
    this.data = data
    return data
  }

  /**
   * @param {string} dshSessionId
   * @param {string} route
   * @returns {Promise<SessionBinding | undefined>}
   */
  async get(dshSessionId, route) {
    const data = await this.load()
    return data.get(dshSessionId)?.[route]
  }

  /**
   * @param {string} dshSessionId
   * @param {string} route
   * @param {SessionBinding} binding
   */
  async set(dshSessionId, route, binding) {
    const data = await this.load()
    const existing = data.get(dshSessionId) ?? Object.create(null)
    existing[route] = binding
    data.set(dshSessionId, existing)
    await this.flush()
  }

  /**
   * @param {string} dshSessionId
   * @param {string} route
   */
  async drop(dshSessionId, route) {
    const data = await this.load()
    const existing = data.get(dshSessionId)
    if (existing === undefined || existing[route] === undefined) return
    delete existing[route]
    if (Object.keys(existing).length === 0) data.delete(dshSessionId)
    await this.flush()
  }

  /**
   * Every durable binding, newest first.
   * @returns {Promise<Array<{ dshSessionId: string, route: string, binding: SessionBinding }>>}
   */
  async all() {
    const data = await this.load()
    const rows = []
    for (const [dshSessionId, byRoute] of data) {
      for (const [route, binding] of Object.entries(byRoute)) {
        rows.push({ dshSessionId, route, binding })
      }
    }
    rows.sort((left, right) => right.binding.lastPromptAt - left.binding.lastPromptAt)
    return rows
  }

  /** Drop the oldest bindings once the map exceeds the cap. */
  prune() {
    const rows = []
    for (const [dshSessionId, byRoute] of this.data ?? []) {
      for (const [route, binding] of Object.entries(byRoute)) {
        rows.push({ dshSessionId, route, at: binding.lastPromptAt })
      }
    }
    if (rows.length <= this.maxBindings) return 0
    rows.sort((left, right) => right.at - left.at)
    let dropped = 0
    for (const row of rows.slice(this.maxBindings)) {
      const byRoute = this.data.get(row.dshSessionId)
      if (byRoute === undefined) continue
      delete byRoute[row.route]
      if (Object.keys(byRoute).length === 0) this.data.delete(row.dshSessionId)
      dropped += 1
    }
    return dropped
  }

  /** Serialize the whole map to disk through one atomic rename. */
  flush() {
    this.prune()
    const snapshot = Object.create(null)
    for (const [dshSessionId, byRoute] of this.data ?? []) {
      const records = Object.create(null)
      for (const [route, binding] of Object.entries(byRoute)) records[route] = binding.toRecord()
      if (Object.keys(records).length > 0) snapshot[dshSessionId] = records
    }
    const body = `${JSON.stringify(snapshot, null, 2)}\n`
    const target = this.path
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (this.readOnly) throw new Error(this.persistenceError)
      await atomicStoreWrite(this, body)
      this.persistenceError = undefined
    }).catch(error => { this.persistenceError = error.message; throw error })
    return this.writes
  }
}
