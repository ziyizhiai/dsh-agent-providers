import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  blockText, humanUserTexts, isHumanUser, renderDelta, renderTranscript, userHistoryDigest,
} from '../lib/render.js'

const user = (text, extra = {}) => ({ role: 'user', content: [{ type: 'text', text }], ...extra })
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const system = (text) => ({ role: 'system', content: [{ type: 'text', text }] })

test('blockText flattens text, tool calls and offloaded images', () => {
  const text = blockText([
    { type: 'text', text: 'hello' },
    { type: 'reasoning', text: 'hidden' },
    { type: 'tool-call', name: 'read', arguments: '{"p":"a"}' },
    { type: 'image', attachment: { name: 'x.png' }, offloaded: true },
  ])
  assert.match(text, /hello/)
  assert.doesNotMatch(text, /hidden/)
  assert.match(text, /\[tool call: read\]/)
  assert.match(text, /offloaded/)
})

test('isHumanUser separates runtime context from typed input', () => {
  assert.equal(isHumanUser(user('hi')), true)
  assert.equal(isHumanUser(user('hi', { source: { kind: 'user' } })), true)
  assert.equal(isHumanUser(user('ctx', { source: { kind: 'runtime-context' } })), false)
  assert.equal(isHumanUser(assistant('x')), false)
})

test('renderTranscript keeps system first and labels roles', () => {
  const out = renderTranscript({ system: 'be terse', messages: [system('sys2'), user('q'), assistant('a')] }, 10_000)
  assert.match(out, /^# System instructions/)
  assert.match(out, /## User\n\nq/)
  assert.match(out, /## Assistant\n\na/)
})

test('renderTranscript drops the oldest sections when over budget', () => {
  const messages = [user('A'.repeat(400)), assistant('B'.repeat(400)), user('latest question')]
  const out = renderTranscript({ messages }, 420)
  assert.match(out, /dropped from this replay/)
  assert.match(out, /latest question/)
  assert.doesNotMatch(out, /AAAA/)
})

test('renderDelta only forwards user text after the last assistant message', () => {
  const messages = [user('first'), assistant('answer'), user('second'), user('third')]
  assert.equal(renderDelta({ messages }), 'second\n\nthird')
})

test('humanUserTexts and userHistoryDigest detect a rewritten prefix', () => {
  const messages = [user('a'), assistant('b'), user('c'),
    user('clock', { source: { kind: 'runtime-context' } })]
  const texts = humanUserTexts({ messages })
  assert.deepEqual(texts, ['a', 'c'], 'injected context is not a user turn')

  const digest = userHistoryDigest(texts, 1)
  assert.equal(digest, userHistoryDigest(['a', 'c'], 1), 'stable for the same prefix')
  assert.notEqual(digest, userHistoryDigest(['a-edited', 'c'], 1), 'a rewritten turn changes it')
  assert.equal(userHistoryDigest(texts, 0).endsWith(':0'), true)
})
