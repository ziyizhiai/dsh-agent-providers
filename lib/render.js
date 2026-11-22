/**
 * Prompt rendering and session-config helpers.
 *
 * Everything here is pure: it turns harness messages into the text an
 * external agent understands, and reads an agent's advertised session
 * configuration. No I/O, no clock, no spawn.
 *
 * @module dsh-agent-providers/render
 */

/** Flatten one message's content blocks into plain text. */
export function blockText(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        // Thinking never becomes conversation content.
        break
      case 'image':
        parts.push(block.offloaded === true
          ? `[image "${block.attachment?.name ?? 'unnamed'}" omitted: offloaded]`
          : `[image "${block.attachment?.name ?? 'unnamed'}" attached to the DSH session; not forwarded]`)
        break
      case 'file':
        parts.push(`[file "${block.attachment?.name ?? 'unnamed'}" attached to the DSH session; read it from the workspace]`)
        break
      case 'tool-call':
        parts.push(`[tool call: ${block.name}]\n${block.arguments}`)
        break
      case 'tool-result': {
        const inner = blockText(block.content)
        parts.push(block.isError === true ? `[tool error]\n${inner}` : `[tool result]\n${inner}`)
        break
      }
      default:
        break
    }
  }
  return parts.join('\n')
}

/** True for a message a human typed, as opposed to harness-injected context. */
export function isHumanUser(message) {
  if (message.role !== 'user') return false
  const source = message.source
  return source === undefined || source === null || source.kind === 'user'
}

/** Render one message as a transcript section, or `undefined` when it is empty. */
function renderMessage(message) {
  const text = blockText(message.content)
  if (text.trim().length === 0) return undefined
  if (message.role === 'assistant') return `## Assistant\n\n${text}`
  if (message.role === 'system') return `## System\n\n${text}`
  return `## User\n\n${text}`
}

/**
 * Render the complete harness request as one prompt. Used by the `replay`
 * continuity mode and whenever a resume is not provably safe.
 *
 * The oldest sections are dropped first when the result exceeds `maxChars`,
 * because the newest turns carry the instruction that is being acted on.
 *
 * @param {{ messages?: readonly unknown[], system?: string }} options
 * @param {number} maxChars
 */
export function renderTranscript(options, maxChars) {
  const systemSection = typeof options.system === 'string' && options.system.length > 0
    ? `# System instructions\n\n${options.system}`
    : undefined
  const sections = []
  for (const message of options.messages ?? []) {
    const rendered = renderMessage(message)
    if (rendered !== undefined) sections.push(rendered)
  }
  if (sections.length === 0 && systemSection === undefined) return ''

  let total = sections.reduce((sum, section) => sum + section.length + 2, 0)
  let drop = 0
  while (total > maxChars && drop < sections.length - 1) {
    total -= sections[drop].length + 2
    drop += 1
  }
  const kept = sections.slice(drop)
  const parts = []
  if (systemSection !== undefined) parts.push(systemSection)
  if (kept.length > 0) {
    const note = drop === 0 ? '' : 'Note: earlier turns were dropped from this replay to fit the context budget.\n\n'
    parts.push(`${note}# Conversation\n\n${kept.join('\n\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * Render only what the external session has not seen yet: every user message
 * after the last assistant message.
 *
 * The trailing slice is deliberate — runtime context the harness injects
 * (current time, working directory) must stay fresh on every turn.
 *
 * @param {{ messages?: readonly any[] }} options
 */
export function renderDelta(options) {
  const messages = options.messages ?? []
  let start = 0
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === 'assistant') start = index + 1
  }
  const parts = []
  for (const message of messages.slice(start)) {
    if (message.role !== 'user') continue
    const text = blockText(message.content)
    if (text.trim().length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

/** The rendered text of every human-authored user turn, oldest first. */
export function humanUserTexts(options) {
  const texts = []
  for (const message of options.messages ?? []) {
    if (!isHumanUser(message)) continue
    const text = blockText(message.content)
    if (text.trim().length > 0) texts.push(text)
  }
  return texts
}

/**
 * Digest of the first `count` user turns.
 *
 * This is the resume drift witness. Comparing whole rendered history would
 * never match, because the request grows by an assistant reply every turn;
 * comparing the *user* prefix detects the cases that actually invalidate an
 * agent session — a compaction rewrite, a fork, an edit, a rewind.
 *
 * @param {readonly string[]} texts - {@link humanUserTexts} output.
 * @param {number} count - how many leading turns were already forwarded.
 */
export function userHistoryDigest(texts, count) {
  const slice = texts.slice(0, Math.max(0, count))
  const payload = slice.join('\u0000')
  let hash = 0x811c9dc5
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}:${slice.length}`
}
