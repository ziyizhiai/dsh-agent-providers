/** Local single-writer transaction: CAS prevents stale instances from overwriting another writer. */
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
export async function fingerprint(path) {
  try { return createHash('sha256').update(await readFile(path)).digest('hex') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function atomicStoreWrite(store, body) {
  await mkdir(dirname(store.path), { recursive: true, mode: 0o700 })
  const lock = `${store.path}.lock`
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = await readFile(`${lock}/owner`, 'utf8').then(JSON.parse).catch(() => undefined)
    let alive = true
    if (owner?.pid) { try { process.kill(owner.pid, 0) } catch (failure) { alive = failure.code !== 'ESRCH' } }
    if (!alive) { await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 }) }
    else { const failure = new Error('state directory is busy; use a separate stateDirectory for each profile/process'); failure.code = 'STATE_BUSY'; throw failure }
  }
  const temporary = `${store.path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(`${lock}/owner`, JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    const actual = await fingerprint(store.path)
    if (actual !== store.diskFingerprint) { const error = new Error('state was changed by another instance; refusing to overwrite it'); error.code = 'STATE_CONFLICT'; throw error }
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, store.path)
    store.diskFingerprint = createHash('sha256').update(body).digest('hex')
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
    await rm(lock, { recursive: true, force: true })
  }
}
