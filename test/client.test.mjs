import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const delay = () => new Promise(resolve => setTimeout(resolve, 10))

test('unknown execution exposes review then acknowledgement without a retry action', async () => {
  let checked = false; let acknowledged = false; const mutations = []
  const env = await mount(url => {
    if (url.includes('/inspect?')) { checked = true; mutations.push('inspect'); return response({ persistence: { saved: true } }) }
    if (url.includes('/acknowledge?')) { acknowledged = true; mutations.push('acknowledge'); return response({ persistence: { saved: true } }) }
    return response(url.includes('/state?') ? { runs: [{ ...run, status: 'unknown', review: checked ? { checkedAt: 123, evidence: [{ path: 'result.txt', state: 'exists' }], ...(acknowledged ? { acknowledgedAt: 456 } : {}) } : undefined }] } : { routes: [] })
  })
  try {
    await click('执行记录')
    assert.match(document.body.textContent, /上一轮结果未知/)
    assert.equal([...document.querySelectorAll('button')].some(button => button.textContent === '我已核对，允许后续回合'), false)
    await click('核对执行证据')
    assert.match(document.body.textContent, /文件存在/)
    await click('我已核对，允许后续回合')
    assert.match(document.body.textContent, /已人工核对（不代表任务成功）/)
    assert.match(document.body.textContent, /执行结果未知/)
    assert.deepEqual(mutations, ['inspect', 'acknowledge'])
  } finally { await env.cleanup() }
})
test('diagnostics and save retry explicitly avoid reexecution and failure codes are localized', async () => {
  let action
  const env = await mount(url => {
    if (url.includes('diagnostics=1')) return response({ version: 1, runs: [{ status: 'completed' }] })
    if (url.includes('/retry-save?')) { action = 'retry-save'; return response({ saved: false }) }
    return response(url.includes('/state?') ? { runs: [{ ...run, persistenceError: 'disk', failure: { code: 'REVIEW_REQUIRED', message: 'english fallback' } }] } : { routes: [] })
  })
  try {
    await click('执行记录')
    assert.match(document.body.textContent, /请先核对上一轮/)
    await click('仅重试保存')
    assert.equal(action, 'retry-save'); assert.match(document.body.textContent, /不要重跑已执行任务/)
    await click('查看诊断')
    assert.ok(document.querySelector('[data-diagnostic]'))
    assert.match(document.body.textContent, /不含对话正文/)
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === '导出诊断JSON'))
  } finally { await env.cleanup() }
})

test('expanded live tool output refreshes when its revision changes', async () => {
  let revision = 1
  const env = await mount(url => {
    if (url.includes('toolId=')) return response({ revision, output: revision === 1 ? 'started' : 'NEW COMPLETED OUTPUT' })
    return response(url.includes('/state?') ? { runs: [{ ...run, status: revision === 1 ? 'running' : 'completed', tools: [{ ...run.tools[0], revision }] }] } : { routes: [] })
  })
  try {
    await click('执行记录')
    await act(async () => { const node = document.querySelector('section details'); node.open = true; node.dispatchEvent(new window.Event('toggle')); await delay() })
    assert.match(document.body.textContent, /started/)
    revision = 2; await click('刷新')
    await act(async () => { await delay() })
    assert.match(document.body.textContent, /NEW COMPLETED OUTPUT/)
  } finally { await env.cleanup() }
})

test('slow inventory does not block activity state and historical config is read-only', async () => {
  let finishInventory
  const env = await mount(url => url.includes('/state?') ? response({ runs: [{ ...run, configOptions: [{ id: 'mode', type: 'select', currentValue: 'build' }] }], configuration: [{ route: 'a', displayName: 'Agent A', configurable: true, options: [{ id: 'mode', type: 'select', category: 'mode', currentValue: 'plan', options: [{ value: 'build' }, { value: 'plan' }] }] }] })
    : new Promise(resolve => { finishInventory = resolve }))
  try {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent === '执行记录')
    await act(async () => { button.click(); await delay() })
    assert.match(document.body.textContent, /修复模块/)
    assert.match(document.body.textContent, /本轮配置（只读）/)
    assert.equal(document.querySelectorAll('select').length, 1)
    assert.equal(document.querySelector('select').value, 'plan')
    finishInventory({ ok: true, json: async () => ({ routes: [] }) })
  } finally { await env.cleanup() }
})

test('unsupported close is not shown', async () => {
  const env = await mount(url => response(url.includes('/state?') ? { runs: [] } : { routes: [{ route: 'a', displayName: 'A', capabilities: [], sessions: [{ sessionId: 'one' }] }] }))
  try { await click('会话'); assert.equal([...document.querySelectorAll('button')].some(node => node.textContent === '关闭'), false) }
  finally { await env.cleanup() }
})

test('collapsed panel discovers a newly started run with lightweight passive polling', async () => {
  let active = false
  const env = await mount(url => response(url.includes('/state?') ? { runs: active ? [{ ...run, status: 'running' }] : [] } : { routes: [] }))
  try {
    active = true
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1400)) })
    assert.match(document.querySelector('[role=status]').textContent, /执行中/)
    assert.equal(document.querySelector('section'), null)
  } finally { await env.cleanup() }
})
async function mount(fetcher, sessionId = 'chat') {
  const dom = new JSDOM('<!doctype html><html lang="zh"><body><div id="root"></div></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  globalThis.window = dom.window; globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; globalThis.fetch = fetcher
  let module
  window.__ModuleLoader__ = { load: definition => { module = definition.factory(name => { assert.equal(name, 'react'); return React }) } }
  new Function(source)()
  let render
  module.apply({ effect: fn => fn(), locale: { register: () => () => {} }, slots: { inject: (_name, fn) => fn(), register: (_meta, fn) => { render = fn } } })
  const root = createRoot(document.getElementById('root'))
  await act(async () => { root.render(render({ sessionId })); await delay() })
  return { root, dom, render, cleanup: async () => { await act(async () => root.unmount()); dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.fetch } }
}
const response = (body, status = 200) => Promise.resolve({ ok: status === 200, status, json: async () => body })
async function click(label) {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent === label)
  assert.ok(button, `button missing: ${label}`)
  await act(async () => { button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await delay() })
}
const run = { id: 'run', route: 'a', title: '修复模块', displayName: 'Agent A', cwd: '/project', status: 'completed', startedAt: 1000, endedAt: 2000, updatedAt: 2000,
  requestedModel: 'choice', actualModel: 'actual', configOptions: [], notices: [],
  plans: [{ id: 'p', content: '测试模块', status: 'completed' }],
  tools: [{ id: 't', title: '运行测试', status: 'completed', locations: [] }],
  artifacts: [{ id: 'f', path: 'result.txt', status: 'verified' }] }

test('real component displays structured activity, lazily expands output, and previews safely as text', async () => {
  const calls = []
  const env = await mount(url => {
    calls.push(url)
    if (url.includes('toolId=')) return response({ output: 'PASS 3 tests' })
    if (url.includes('artifactId=')) return response({ path: 'result.txt', text: '<script>bad()</script>', changedSinceVerified: true })
    return response(url.includes('/state?') ? { runs: [run] } : { routes: [] })
  })
  try {
    await click('执行记录')
    assert.match(document.body.textContent, /实际模型: actual/)
    assert.match(document.body.textContent, /测试模块/)
    assert.equal(calls.some(url => url.includes('toolId=')), false)
    await act(async () => { const details = document.querySelector('section details'); details.open = true; details.dispatchEvent(new window.Event('toggle')); await delay() })
    assert.match(document.body.textContent, /PASS 3 tests/)
    await click('查看文件')
    assert.match(document.body.textContent, /发生变化/)
    assert.match(document.body.textContent, /<script>bad\(\)<\/script>/)
    assert.equal(document.querySelector('script'), null)
  } finally { await env.cleanup() }
})

test('refresh failure retains the last successful data and shows a visible error', async () => {
  let failure = false
  const env = await mount(url => failure ? response({ error: { message: 'offline' } }, 500) : response(url.includes('/state?') ? { runs: [run] } : { routes: [] }))
  try {
    await click('执行记录'); failure = true; await click('刷新')
    assert.match(document.body.textContent, /保留上次数据/); assert.match(document.body.textContent, /修复模块/)
  } finally { await env.cleanup() }
})

test('switching conversations ignores a stale response from the old conversation', async () => {
  let resolveOld
  const env = await mount(url => {
    if (url.includes('dshSessionId=old')) return new Promise(resolve => { resolveOld = resolve })
    return response(url.includes('/state?') ? { runs: [{ ...run, title: '新会话' }] } : { routes: [] })
  }, 'old')
  try {
    await act(async () => { env.root.render(env.render({ sessionId: 'new' })); await delay() })
    await act(async () => { resolveOld({ ok: true, json: async () => ({ runs: [{ ...run, title: '旧响应' }] }) }); await delay() })
    await click('执行记录'); assert.match(document.body.textContent, /新会话/); assert.doesNotMatch(document.body.textContent, /旧响应/)
  } finally { await env.cleanup() }
})

test('current badge is scoped correctly and duplicate mutations are disabled', async () => {
  let calls = 0; let resolveAction
  const routes = [{ route: 'a', displayName: 'Agent A', capabilities: ['delete', 'close'], sessions: [
    { sessionId: 'one', dshSessionId: 'chat', title: '当前标题' }, { sessionId: 'two', dshSessionId: 'other', title: '其他标题' }] }]
  const env = await mount(url => {
    if (url.includes('/close?')) { calls++; return new Promise(resolve => { resolveAction = resolve }) }
    return response(url.includes('/state?') ? { runs: [] } : { routes })
  })
  try {
    await click('会话')
    assert.equal([...document.querySelectorAll('span')].filter(node => node.textContent === '当前会话').length, 1)
    assert.match(document.body.textContent, /已关联/)
    await click('关闭')
    assert.equal(document.querySelector('button:disabled')?.textContent, '处理中…')
    assert.equal(calls, 1)
    await act(async () => { resolveAction({ ok: true, json: async () => ({ closed: true }) }); await delay() })
    assert.match(document.body.textContent, /操作完成/)
  } finally { await env.cleanup() }
})
