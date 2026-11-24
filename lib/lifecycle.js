/** Shared lifecycle helpers: one cancellation vocabulary and bounded queues. */
export function abortError(message = 'the operation was cancelled') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORTED'
  return error
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

export function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  let listener
  const aborted = new Promise((_, reject) => {
    listener = () => reject(abortError())
    signal.addEventListener('abort', listener, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', listener))
}

/** FIFO, cancellable admission; callers always release in finally. */
export class Semaphore {
  constructor(limit = 2) { this.limit = limit; this.active = 0; this.queue = [] }
  acquire(signal) {
    throwIfAborted(signal)
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal }
      entry.abort = () => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(abortError())
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.queue.push(entry)
      this.drain()
    })
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift()
      entry.signal?.removeEventListener('abort', entry.abort)
      if (entry.signal?.aborted) { entry.reject(abortError()); continue }
      this.active++
      let released = false
      entry.resolve(() => { if (!released) { released = true; this.active--; this.drain() } })
    }
  }
}

/** Stop only the child we own; a trapped TERM cannot hold a CLI turn forever. */
export function terminateChild(child, graceMs = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return () => {}
  try { child.kill('SIGTERM') } catch {}
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, graceMs)
  timer.unref?.()
  const clear = () => clearTimeout(timer)
  child.once('close', clear)
  return clear
}
