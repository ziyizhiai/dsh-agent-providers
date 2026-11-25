/** Bounded, durable read-only execution records. Never feeds tools back to DSH. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactText, redactValue } from './redact.js'
import { atomicStoreWrite, fingerprint } from './storage.js'

const ACTIVE = new Set(['queued', 'starting', 'running', 'waiting', 'finalizing', 'cancelling'])
const OPEN_TOOL = new Set(['pending', 'started', 'in_progress'])
export const LIMITS = Object.freeze({ runs: 40, tools: 80, artifacts: 40, detail: 8000, plans: 80, previewBytes: 262144 })
const clip = (value, limit = LIMITS.detail) => typeof value === 'string' ? value.slice(-limit) : undefined
export function safeValue(value, depth = 0) {
  return redactValue(value, [], depth)
}
const display = (value) => typeof value === 'string' ? safeValue(value) : value === undefined ? undefined : JSON.stringify(safeValue(value))

export function normalizeTool(update, previous, fallbackId) {
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : fallbackId
  const rawTitle = update.title ?? update.name
  const title = typeof rawTitle === 'string' && rawTitle.trim() && !/^call_[A-Za-z0-9_-]{8,}$/.test(rawTitle)
    ? rawTitle.trim().slice(0, 500) : previous?.title ?? update.kind ?? 'tool'
  const status = update.status ?? previous?.status ?? 'started'
  const result = { ...previous, type: 'tool', id, title: redactText(title), status }
  for (const key of ['kind', 'rawInput', 'rawOutput', 'locations', 'content']) {
    if (Object.hasOwn(update, key)) {
      const value = safeValue(update[key])
      const encoded = JSON.stringify(value)
      result[key] = key === 'locations' ? (Array.isArray(value) ? value.slice(0, 40) : [])
        : key === 'content' ? (Array.isArray(value) ? value.filter((entry) => JSON.stringify(entry).length < 16000).slice(0, 10) : [])
          : encoded?.length > 16000 ? `[detail truncated]\n${encoded.slice(-16000)}` : value
    }
  }
  return result
}

export class ActivityStore {
  constructor(profileDir, options = {}) {
    this.path = join(profileDir, 'agent-providers', 'activity.json')
    this.runs = new Map(); this.maxRuns = options.maxRuns ?? LIMITS.runs
    this.diskFingerprint = null
    this.loaded = false; this.writes = Promise.resolve(); this.revision = 0
  }
  async load() {
    if (this.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      this.diskFingerprint = await fingerprint(this.path)
      try {
        const info = await stat(this.path)
        if (info.size > 8 * 1024 * 1024) throw new Error('activity store exceeds size bound')
        const body = JSON.parse(await readFile(this.path, 'utf8'))
        const rows = Array.isArray(body.runs) ? body.runs : []
        const selected = new Set([...rows.slice(-this.maxRuns), ...rows.filter(row => (row.status === 'unknown' || (row.status === 'interrupted' && row.failure?.code === 'PROCESS_LOST')) && !row.review?.acknowledgedAt)])
        for (const row of selected) {
          if (!row?.id || !row?.dshSessionId || !Array.isArray(row.tools)) continue
          const run = { ...row, tools: row.tools.slice(-LIMITS.tools), artifacts: (row.artifacts ?? []).slice(-LIMITS.artifacts),
            plans: (row.plans ?? []).slice(-LIMITS.plans), configOptions: row.configOptions ?? [], notices: row.notices ?? [] }
          if (ACTIVE.has(run.status)) this.settleRun(run, 'interrupted', { code: 'PROCESS_LOST', message: 'The previous provider process is gone; this record is read-only.' })
          this.runs.set(run.id, run)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.persistenceError = `Previous activity history could not be read: ${redactText(error.message)}`
          this.readOnly = true // Preserve damaged source; new runs remain available in memory.
        }
      }
      this.revision = Math.max(this.revision, ...[...this.runs.values()].map(run => run.revision ?? 0))
      this.loaded = true
    })().finally(() => { this.loading = undefined })
    return this.loading
  }
  async begin(meta) {
    await this.load()
    const run = { id: randomUUID(), ...meta, status: 'queued', startedAt: Date.now(), updatedAt: Date.now(),
      tools: [], plans: [], artifacts: [], notices: [], configOptions: [], revision: ++this.revision }
    this.runs.set(run.id, run); this.prune(); this.schedule()
    return run.id
  }
  prune() {
    const inactive = [...this.runs.values()].filter(run => !ACTIVE.has(run.status) && !((run.status === 'unknown' || (run.status === 'interrupted' && run.failure?.code === 'PROCESS_LOST')) && !run.review?.acknowledgedAt)).sort((a, b) => a.updatedAt - b.updatedAt)
    while (this.runs.size > this.maxRuns && inactive.length) this.runs.delete(inactive.shift().id)
    let bytes = Buffer.byteLength(JSON.stringify([...this.runs.values()]))
    while (bytes > 6 * 1024 * 1024 && inactive.length > 1) {
      this.runs.delete(inactive.shift().id)
      bytes = Buffer.byteLength(JSON.stringify([...this.runs.values()]))
    }
  }
  update(id, patch) {
    const run = this.runs.get(id)
    if (!run || !ACTIVE.has(run.status)) return
    Object.assign(run, patch, { updatedAt: Date.now(), revision: ++this.revision }); this.schedule()
  }
  notice(id, text) {
    const run = this.runs.get(id)
    if (!run) return
    run.notices = [...run.notices, safeValue(text)].slice(-8); this.update(id, {})
  }
  accept(id, event) {
    const run = this.runs.get(id)
    if (!run || !ACTIVE.has(run.status)) return
    if (event.type === 'tool') {
      const index = run.tools.findIndex((tool) => tool.id === event.id)
      const previous = index >= 0 ? run.tools[index] : undefined
      const tool = { ...previous, ...safeValue(event), startedAt: previous?.startedAt ?? Date.now(), revision: (previous?.revision ?? 0) + 1 }
      if (!OPEN_TOOL.has(tool.status)) tool.endedAt = tool.endedAt ?? Date.now()
      if (index >= 0) run.tools[index] = tool
      else { run.tools.push(tool); if (run.tools.length > LIMITS.tools) { run.tools.shift(); run.toolsTruncated = true } }
      if (tool.kind === 'edit' && tool.status === 'completed') {
        const paths = [...(tool.locations ?? []).map((entry) => entry.path), ...(tool.content ?? []).filter((entry) => entry.type === 'diff').map((entry) => entry.path)].filter((value) => typeof value === 'string')
        for (const path of new Set(paths)) {
          if (!run.artifacts.some((artifact) => artifact.path === path) && run.artifacts.length < LIMITS.artifacts) {
            run.artifacts.push({ id: randomUUID(), path, source: 'provider', status: 'reported', toolId: tool.id })
          }
        }
      }
    } else if (event.type === 'plan') {
      run.plans = (event.entries ?? []).slice(0, LIMITS.plans)
    } else if (event.type === 'config') {
      run.configOptions = safeValue(event.options) ?? []
      if (Object.hasOwn(event, 'actualModel')) { run.actualModel = event.actualModel; run.modelConfirmed = event.actualModel !== undefined }
    } else if (event.type === 'notice') this.notice(id, event.text)
    else if (event.type === 'context') run.context = { used: event.used, size: event.size }
    else if (event.type === 'title') run.title = clip(redactText(event.title), 200)
    else if (event.type === 'model') { run.actualModel = event.value; run.modelConfirmed = true }
    else if (event.type === 'approval') run.status = event.status === 'pending' ? 'waiting' : 'running'
    else if (event.type === 'commands') run.commands = safeValue(event.commands)
    this.update(id, {})
  }
  settleRun(run, status, failure) {
    run.status = status; run.endedAt = Date.now(); run.updatedAt = run.endedAt
    if (failure) run.failure = { code: failure.executionUnknown ? 'EXECUTION_UNKNOWN' : failure.code ?? 'PROVIDER', message: safeValue(failure.message) }
    for (const tool of run.tools) if (OPEN_TOOL.has(tool.status)) { tool.status = 'interrupted'; tool.endedAt = run.endedAt }
    for (const step of run.plans) if (step.status === 'in_progress') step.status = 'interrupted'
    run.revision = ++this.revision
  }
  async settle(id, status, failure, usage) {
    const run = this.runs.get(id)
    if (!run) return
    if (usage) run.usage = safeValue(usage)
    if (ACTIVE.has(run.status)) this.settleRun(run, status, failure)
    this.prune()
    try { await this.flush() } catch (error) {
      this.persistenceError = redactText(error.message)
      run.persistenceError = this.persistenceError
      // Execution has already settled; saving cannot turn success into a retryable execution failure.
    }
  }
  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.flush().catch((error) => { this.persistenceError = error.message }) }, 250)
    this.timer.unref?.()
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined
    this.prune()
    const body = JSON.stringify({ version: 1, runs: [...this.runs.values()] })
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('active execution records exceed the storage budget')
      if (this.readOnly) throw new Error(this.persistenceError)
      await atomicStoreWrite(this, body)
      this.persistenceError = undefined
      for (const run of this.runs.values()) delete run.persistenceError
    })
    return this.writes
  }
  async updateConfiguration(dshSessionId, route, options) {
    // Historical run configuration is immutable. Current session configuration lives in bindings.
    await this.load()
  }

  scopedRun(dshSessionId, runId) {
    const run = this.runs.get(runId)
    if (!run || run.dshSessionId !== dshSessionId) { const error = new Error('execution record not found'); error.code = 'NOT_FOUND'; throw error }
    return run
  }

  async unresolved(dshSessionId, route) {
    await this.load()
    return [...this.runs.values()].filter(run => run.dshSessionId === dshSessionId && run.route === route
      && (run.status === 'unknown' || (run.status === 'interrupted' && run.failure?.code === 'PROCESS_LOST'))
      && !run.review?.acknowledgedAt)
  }

  /** Inspect reported files only. Does not execute tools, resume a prompt, or change its outcome. */
  async review(dshSessionId, runId) {
    await this.load()
    const run = this.scopedRun(dshSessionId, runId)
    if (ACTIVE.has(run.status)) { const error = new Error('stop the active turn before reviewing its result'); error.code = 'BUSY'; throw error }
    const paths = new Set(run.artifacts.map(artifact => artifact.path))
    for (const tool of run.tools) if (tool.kind === 'edit') {
      for (const location of tool.locations ?? []) if (typeof location.path === 'string') paths.add(location.path)
      for (const block of tool.content ?? []) if (block.type === 'diff' && typeof block.path === 'string') paths.add(block.path)
    }
    const evidence = []
    for (const path of [...paths].slice(0, LIMITS.artifacts)) {
      try {
        const resolved = await this.resolveArtifact(run, { path })
        const info = await stat(resolved)
        if (!info.isFile()) throw new Error('not a regular file')
        evidence.push({ path, state: 'exists', bytes: info.size })
      } catch (error) { evidence.push({ path, state: 'unavailable', error: redactText(error.message) }) }
    }
    run.review = { ...run.review, checkedAt: Date.now(), evidence, scope: 'reported-files-only',
      unknownTools: run.tools.filter(tool => tool.status === 'interrupted').length }
    run.revision = ++this.revision; run.updatedAt = Date.now()
    const persistence = await this.saveWithoutExecution()
    return { review: structuredClone(run.review), persistence, executionStatus: run.status }
  }

  async acknowledge(dshSessionId, runId) {
    await this.load()
    const run = this.scopedRun(dshSessionId, runId)
    if (ACTIVE.has(run.status)) { const error = new Error('active execution cannot be acknowledged'); error.code = 'BUSY'; throw error }
    if (!run.review?.checkedAt) { const error = new Error('inspect the execution evidence before acknowledging'); error.code = 'REVIEW_REQUIRED'; throw error }
    run.review = { ...run.review, acknowledgedAt: Date.now(), acknowledgement: 'human-reviewed-no-automatic-retry' }
    run.revision = ++this.revision; run.updatedAt = Date.now()
    return { review: structuredClone(run.review), persistence: await this.saveWithoutExecution(), executionStatus: run.status }
  }

  async saveWithoutExecution() {
    try { await this.flush(); return { saved: true } }
    catch (error) { this.persistenceError = redactText(error.message); return { saved: false, error: this.persistenceError, code: error.code ?? 'STATE_SAVE' } }
  }

  async diagnostics(dshSessionId) {
    await this.load()
    return {
      version: 1, exportedAt: new Date().toISOString(),
      persistence: { saved: !this.persistenceError, readOnly: Boolean(this.readOnly), error: this.persistenceError },
      // Explicit allowlist: no prompts, raw inputs/outputs, credentials, config values or launch environment.
      runs: [...this.runs.values()].filter(run => run.dshSessionId === dshSessionId).slice(-this.maxRuns).map(run => ({
        id: run.id, route: run.route, status: run.status, startedAt: run.startedAt, executionStartedAt: run.executionStartedAt,
        endedAt: run.endedAt, failure: safeValue(run.failure), persistenceError: this.persistenceError ?? run.bindingPersistenceError,
        requestedModel: run.requestedModel, actualModel: run.actualModel,
        tools: run.tools.map(tool => ({ id: tool.id, kind: tool.kind, status: tool.status, startedAt: tool.startedAt, endedAt: tool.endedAt })),
        artifacts: run.artifacts.map(artifact => ({ path: artifact.path, status: artifact.status, bytes: artifact.bytes })),
        review: safeValue(run.review),
      })),
    }
  }

  async list(dshSessionId) {
    await this.load()
    return [...this.runs.values()].filter((run) => run.dshSessionId === dshSessionId).sort((a, b) => b.startedAt - a.startedAt).map((run) => ({
      ...structuredClone(run), persistenceError: this.persistenceError,
      tools: run.tools.map(({ rawInput, rawOutput, content, ...tool }) => structuredClone(tool)),
    }))
  }
  async detail(dshSessionId, runId, toolId) {
    await this.load()
    const run = this.runs.get(runId)
    if (!run || run.dshSessionId !== dshSessionId) throw new Error('execution record not found')
    const tool = run.tools.find((row) => row.id === toolId)
    if (!tool) throw new Error('tool record not found')
    return { revision: tool.revision, input: display(tool.rawInput), output: display(tool.rawOutput), content: safeValue(tool.content) }
  }
  async resolveArtifact(run, artifact) {
    const root = await realpath(run.cwd)
    const input = artifact.path.startsWith('file:') ? fileURLToPath(artifact.path) : artifact.path
    const path = await realpath(resolve(root, input))
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('artifact is outside this conversation workspace')
    return path
  }
  async verify(id) {
    const run = this.runs.get(id)
    if (!run) return
    for (const artifact of run.artifacts) {
      try {
        const path = await this.resolveArtifact(run, artifact); const info = await stat(path)
        if (!info.isFile()) throw new Error('not a regular file')
        artifact.status = 'verified'; artifact.bytes = info.size; artifact.verifiedAt = Date.now()
        if (info.size <= LIMITS.previewBytes) artifact.digest = createHash('sha256').update(await readFile(path)).digest('hex')
      } catch (error) { artifact.status = 'unavailable'; artifact.error = error.message }
    }
  }
  async preview(dshSessionId, runId, artifactId) {
    await this.load()
    const run = this.runs.get(runId)
    const artifact = run?.artifacts.find((row) => row.id === artifactId)
    if (!run || run.dshSessionId !== dshSessionId || !artifact) throw new Error('artifact not found')
    const path = await this.resolveArtifact(run, artifact); const info = await stat(path)
    if (!info.isFile() || info.size > LIMITS.previewBytes) throw new Error('file is unavailable or too large for inline preview')
    const bytes = await readFile(path)
    if (bytes.length > LIMITS.previewBytes) throw new Error('file grew beyond the inline preview budget')
    if (bytes.includes(0)) throw new Error('binary files are not available as text previews')
    return { path: artifact.path, text: redactText(bytes.toString('utf8')), changedSinceVerified: artifact.digest !== undefined && artifact.digest !== createHash('sha256').update(bytes).digest('hex') }
  }
}
