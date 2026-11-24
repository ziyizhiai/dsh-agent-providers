/** One bounded sanitization policy for UI, errors, logs and launch diagnostics. */
const SECRET = /(?:api.?key|authorization|password|secret|token|credential|auth.?content)/i
export function redactText(input, secrets = []) {
  let text = String(input ?? '')
  for (const value of secrets) if (typeof value === 'string' && value.length >= 4) text = text.split(value).join('[redacted]')
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(["']?(?:api[_-]?key|password|secret|token|authorization|auth[_-]?content)["']?\s*[=:]\s*)(["'])(.*?)\2/gi, '$1$2[redacted]$2')
    .replace(/((?:--)?(?:api[_-]?key|password|secret|token|authorization)\s*(?:[=:]|\s)\s*)([^\s,;"']+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
}
export function redactValue(value, secrets = [], depth = 0) {
  if (depth > 6) return '[depth limited]'
  if (typeof value === 'string') return redactText(value, secrets).slice(-16000)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.slice(0, 80).map(entry => redactValue(entry, secrets, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80)
    .filter(([key]) => !['__proto__', 'prototype', 'constructor'].includes(key))
    .map(([key, entry]) => [key, SECRET.test(key) ? '[redacted]' : redactValue(entry, secrets, depth + 1)]))
  return undefined
}
export function redactArgs(args, secrets = []) {
  let hideNext = false
  return args.map(arg => {
    if (hideNext) { hideNext = false; return '[redacted]' }
    if (/^--?(?:api[_-]?key|token|secret|password|authorization)$/i.test(arg)) hideNext = true
    return redactText(arg, secrets)
  })
}
export function sensitiveValues(profile) {
  return Object.entries(profile.env ?? {}).filter(([key]) => SECRET.test(key)).map(([, value]) => value)
}
export function safeError(error, secrets = []) {
  const safe = new Error(redactText(error?.message ?? error, secrets))
  safe.name = error?.name ?? 'Error'
  for (const key of ['code', 'silent', 'executionUnknown']) if (error?.[key] !== undefined) safe[key] = error[key]
  return safe
}
export function safeLogger(logger, secrets = []) {
  if (!logger) return undefined
  return { error: (...args) => logger.error?.(...args.map(arg => arg instanceof Error ? safeError(arg, secrets) : redactValue(arg, secrets))) }
}
