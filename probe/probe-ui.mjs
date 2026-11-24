#!/usr/bin/env node
/** Real plugin UI and adapter over local HTTP, using a protocol-faithful synthetic agent; no inference. */
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentProviderAdapter } from '../lib/adapter.js'
import { SessionRegistry } from '../lib/registry.js'
import { ActivityStore } from '../lib/activity.js'
import { SessionAdmin } from '../lib/sessions.js'
import { resolveAgent } from '../lib/config.js'
import { handleInventory, handleState, handleAction } from '../lib/http.js'
const root = await mkdtemp(join(tmpdir(), 'agent-ui-probe-'))
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const profile = resolveAgent('demo', { command: process.execPath, args: [join(repo, 'test/fake-agent.mjs')],
  models: [{ id: 'fake/opus' }], displayName: '测试 Agent', env: { FAKE_ACP_PACING_MS: process.env.UI_PACING_MS ?? '200', FAKE_ACP_PACING_STEPS: process.env.UI_PACING_STEPS ?? '10' }, permission: 'reject' })
const registry = new SessionRegistry(root)
const activity = new ActivityStore(root)
const adapter = new AgentProviderAdapter({ current: () => ({ profiles: new Map([['demo', profile]]), maxReplayChars: 100000 }),
  registry, activity, resolveCwd: () => root, credentials: { resolve: async () => undefined }, logger: { error() {} } })
const admin = new SessionAdmin({ adapter, registry, current: adapter.current, resolveCwd: () => root })
const sid = 'ui-probe'
const user = text => ({ role: 'user', content: [{ type: 'text', text }] })
let history = []
async function turn() {
  const messages = [...history, user('检查模块并运行测试')]
  let answer = ''
  try {
    for await (const event of adapter.stream({ provider: 'demo', model: 'fake/opus', sessionId: sid, messages })) if (event.type === 'text-delta') answer += event.text
    history = [...messages, { role: 'assistant', content: [{ type: 'text', text: answer }] }]
  } catch {}
}
await turn()
// Synthetic result fixture is explicitly labelled and exercises file verification, never claims real agent edits.
await writeFile(join(root, 'result.txt'), 'PASS: UI fixture preview\n')
const fixture = await activity.begin({ dshSessionId: sid, route: 'demo', displayName: '测试 Agent', cwd: root, title: '成果预览测试样例', requestedModel: 'fake/opus', actualModel: 'fake/opus' })
activity.accept(fixture, { type: 'tool', id: 'edit', title: '测试样例：写入结果文件', kind: 'edit', status: 'completed', locations: [{ path: 'result.txt' }], rawOutput: 'PASS: UI fixture preview' })
await activity.verify(fixture); await activity.settle(fixture, 'completed')
let failNext = false
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>Agent 工作区联调</title><body style="margin:40px;font-family:system-ui;background:#f7f8fa;color:#252a32"><main style="max-width:900px;margin:auto"><h2>插件交互验收 · 测试样例</h2><p>真实插件组件与真实 ACP 子进程；样例数据不代表模型推理效果。</p><button id="start">启动测试回合</button><button id="fail">模拟下一次刷新失败</button><div id="root" style="margin-top:20px;background:white"></div></main><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(d){const plugin=d.factory(n=>window.React);let render;plugin.apply({effect:f=>f(),locale:{register:()=>()=>{}},slots:{inject:(n,f)=>f(),register:(m,f)=>{render=f}}});window.ReactDOM.createRoot(document.getElementById('root')).render(render({sessionId:'${sid}'}))}};document.getElementById('start').onclick=()=>fetch('/start',{method:'POST'});document.getElementById('fail').onclick=()=>fetch('/fail',{method:'POST'});</script><script src="/client.js"></script></body></html>`
// React 18 UMD is isolated test-only; the plugin itself stays on the host's React.
const vendor = process.env.UI_VENDOR_DIR
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(html) }
    if (url.pathname === '/client.js') { res.setHeader('content-type', 'application/javascript'); return res.end(await readFile(join(repo, 'lib/client.js'))) }
    if (url.pathname === '/react.js' || url.pathname === '/react-dom.js') {
      const path = url.pathname === '/react.js' ? 'react/umd/react.development.js' : 'react-dom/umd/react-dom.development.js'
      res.setHeader('content-type', 'application/javascript'); return res.end(await readFile(join(vendor, 'node_modules', path)))
    }
    if (url.pathname === '/start') { void turn(); return res.end('started') }
    if (url.pathname === '/fail') { failNext = true; return res.end('ready') }
    if (failNext && url.pathname === '/agent-providers') { failNext = false; res.statusCode = 500; return res.end(JSON.stringify({ error: { message: '测试断连' } })) }
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers })
    const response = url.pathname === '/agent-providers' ? await handleInventory(admin, request)
      : url.pathname.endsWith('/state') ? await handleState(admin, request) : await handleAction(admin, request)
    res.statusCode = response.status; for (const [key, value] of response.headers) res.setHeader(key, value)
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })) }
})
server.listen(Number(process.env.UI_PORT ?? 18765), '127.0.0.1', () => console.log('UI probe http://127.0.0.1:18765'))
async function close() { server.close(); await adapter.dispose(); await rm(root, { recursive: true, force: true }); process.exit() }
process.on('SIGTERM', close); process.on('SIGINT', close)
