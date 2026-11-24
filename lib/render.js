/**
 * Prompt rendering and session-config helpers.
 *
 * Everything here is pure: it turns harness messages into the text an
 * external agent understands, and reads an agent's advertised session
 * configuration. No I/O, no clock, no spawn.
 *
 * @module dsh-agent-providers/render
 */

import { createHash } from 'node:crypto'

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
// Runtime-injected context changes every turn; hash durable conversation only.
export function conversationMessages(options) {
  return (options.messages ?? []).filter((message) => isHumanUser(message) || message.role === 'assistant')
}

export function conversationDigest(messages, count = messages.length) {
  const canonical = messages.slice(0, count).map((message) => ({
    role: message.role,
    text: blockText(message.content),
    attachments: (message.content ?? []).filter((block) => block.type === 'image' || block.type === 'file')
      .map((block) => ({ type: block.type, attachment: block.attachment, offloaded: block.offloaded })),
  }))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Witness includes the just-produced answer so edits/handoffs cannot silently resume stale state. */
export function systemDigest(options) {
  const sections = [options.system ?? '', ...(options.messages ?? []).filter((message) => message.role === 'system').map((message) => blockText(message.content))]
  return createHash('sha256').update(JSON.stringify(sections)).digest('hex')
}

export function conversationWitness(options, answer) {
  const messages = conversationMessages(options)
  if (answer.length > 0) messages.push({ role: 'assistant', content: [{ type: 'text', text: answer }] })
  return { sentMessageCount: messages.length, sentMessageDigest: conversationDigest(messages), sentSystemDigest: systemDigest(options) }
}

export function continuityDecision(options, binding) {
  if (!binding) return { resume: false, reason: 'new' }
  if (binding.sentSystemDigest && binding.sentSystemDigest !== systemDigest(options)) return { resume: false, reason: 'system_changed' }
  const messages = conversationMessages(options)
  if (Number.isInteger(binding.sentMessageCount) && binding.sentMessageDigest) {
    if (binding.sentMessageCount > messages.length
      || binding.sentMessageDigest !== conversationDigest(messages, binding.sentMessageCount)) {
      return { resume: false, reason: 'history_changed' }
    }
    // Another provider completed work after this binding's cursor: hand it the full transcript.
    if (messages.slice(binding.sentMessageCount).some((message) => message.role === 'assistant')) {
      return { resume: false, reason: 'handoff' }
    }
    return { resume: true, reason: 'resume' }
  }
  // Migrate legacy bindings only for an immediate next turn; older bindings need a replay.
  const users = humanUserTexts(options)
  return {
    resume: users.length === binding.sentUserCount + 1
      && binding.sentUserDigest === userHistoryDigest(users, binding.sentUserCount),
    reason: 'legacy',
  }
}

/** Replayed prompts have a hard budget. Never silently cut the newest instruction or system. */
export function renderTranscript(options, maxChars) {
  const systemSection = typeof options.system === 'string' && options.system.length > 0
    ? `# System instructions\n\n${options.system}` : undefined
  const sections = (options.messages ?? []).map(renderMessage).filter((value) => value !== undefined)
  if (!sections.length && systemSection === undefined) return ''
  const note = 'Note: earlier turns were dropped from this replay to fit the context budget.\n\n'
  const build = (drop) => [systemSection, sections.length
    ? `${drop ? note : ''}# Conversation\n\n${sections.slice(drop).join('\n\n')}` : undefined]
    .filter((value) => value !== undefined).join('\n\n')
  let drop = 0
  let result = build(drop)
  while (result.length > maxChars && drop < sections.length - 1) result = build(++drop)
  if (result.length > maxChars) {
    const error = new Error('system instructions and newest message exceed maxReplayChars; increase the replay budget')
    error.code = 'REPLAY_BUDGET'
    throw error
  }
  return result
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
