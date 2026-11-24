window.__ModuleLoader__.load({
  id: 'dsh-agent-providers',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/agent-providers/api'
    const HEADERS = { accept: 'application/json', 'x-dsh-agent-providers': '1' }
    const ACTIVE = ['queued', 'starting', 'running', 'waiting', 'finalizing']
    const DICT = {
      zh: {
        title: 'Agent 工作区', manage: '会话', activity: '执行记录', hide: '收起', refresh: '刷新', loading: '正在刷新…',
        empty: '暂无执行记录', noRoutes: '尚未配置 Agent', bound: '当前会话', linked: '已关联',
        close: '关闭', delete: '删除', fork: '分叉当前对话', stop: '停止', working: '处理中…',
        failed: '操作失败：{message}', stale: '刷新失败，保留上次数据：{message}', success: '操作完成',
        confirmDelete: '删除后无法恢复，确定删除？', unsupported: '此后端不支持列举会话',
        queued: '等待执行', starting: '正在启动', running: '执行中', waiting: '等待授权', finalizing: '正在保存结果',
        completed: '已完成', cancelled: '已取消', interrupted: '已中断', pending: '待处理', started: '执行中', in_progress: '执行中',
        unavailable: '不可用', verified: '文件已验证', reported: 'Agent 已报告', result: '成果', plan: '执行进度',
        tools: '工具活动', preview: '查看文件', details: '查看详情', input: '输入', output: '输出',
        actual: '实际模型', requested: '请求模型', unknown: '后端未确认', config: '会话选项',
        changed: '文件已在本轮结束后发生变化', truncated: '仅保留最近的工具记录',
        passive: '已保存的会话；点击刷新读取后端', minutes: '{count} 个会话', noDetail: '后端未提供详情',
        previewClose: '关闭预览', persistence: '执行记录保存失败', branch: '分支会话', failedStatus: '失败',
      },
      en: {
        title: 'Agent workspace', manage: 'Sessions', activity: 'Activity', hide: 'Hide', refresh: 'Refresh', loading: 'Refreshing…',
        empty: 'No execution records yet', noRoutes: 'No configured agents', bound: 'This conversation', linked: 'Linked',
        close: 'Close', delete: 'Delete', fork: 'Fork this chat', stop: 'Stop', working: 'Working…',
        failed: 'Action failed: {message}', stale: 'Refresh failed; previous data retained: {message}', success: 'Action completed',
        confirmDelete: 'Delete cannot be undone. Continue?', unsupported: 'This backend cannot list sessions',
        queued: 'Queued', starting: 'Starting', running: 'Running', waiting: 'Waiting for approval', finalizing: 'Saving results',
        completed: 'Completed', cancelled: 'Cancelled', interrupted: 'Interrupted', pending: 'Pending', started: 'Running', in_progress: 'Running',
        unavailable: 'Unavailable', verified: 'File verified', reported: 'Reported by agent', result: 'Results', plan: 'Progress',
        tools: 'Tool activity', preview: 'View file', details: 'View details', input: 'Input', output: 'Output',
        actual: 'Actual model', requested: 'Requested model', unknown: 'Not confirmed by backend', config: 'Session options',
        changed: 'This file changed after the turn ended', truncated: 'Only recent tool records are retained',
        passive: 'Saved sessions; Refresh reads the backend', minutes: '{count} session(s)', noDetail: 'No detail supplied by backend',
        previewClose: 'Close preview', persistence: 'Execution record could not be saved', branch: 'Branch', failedStatus: 'Failed',
      },
    }
    const S = {
      root: { fontSize: 12, borderTop: '1px solid rgba(127,127,127,.25)', padding: '8px 10px', color: 'inherit', minWidth: 0 },
      bar: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 0 },
      button: { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid rgba(127,127,127,.3)', borderRadius: 6, padding: '3px 8px', cursor: 'pointer' },
      panel: { marginTop: 8, maxHeight: 360, overflowY: 'auto', overscrollBehavior: 'contain', overflowAnchor: 'none' },
      card: { border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, padding: 10, marginBottom: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', flexWrap: 'wrap' },
      muted: { opacity: .7, overflowWrap: 'anywhere' },
      error: { color: '#c85a4a', padding: '6px 0', overflowWrap: 'anywhere' },
      badge: { padding: '1px 5px', borderRadius: 4, border: '1px solid rgba(127,127,127,.3)', whiteSpace: 'nowrap' },
      pre: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', margin: '5px 0', fontSize: 11 },
      heading: { fontWeight: 600, margin: '8px 0 4px' },
    }
    function translator(ctx) {
      return (key, values) => {
        const lang = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
        const text = DICT[lang][key] ?? DICT.en[key] ?? key
        return text.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''))
      }
    }
    async function readJson(url, options) {
      const response = await fetch(url, { headers: HEADERS, cache: 'no-store', ...options })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`)
      return body
    }
    function query(params) { return new URLSearchParams(params).toString() }

    function AgentWorkspace({ sessionId, t }) {
      const [tab, setTab] = React.useState(null)
      const [routes, setRoutes] = React.useState([])
      const [runs, setRuns] = React.useState([])
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [pending, setPending] = React.useState({})
      const [details, setDetails] = React.useState({})
      const [preview, setPreview] = React.useState(null)
      const generation = React.useRef(0)
      const abortRef = React.useRef(null)
      const actions = React.useRef(new Set())
      const sessionRef = React.useRef(sessionId)
      const serial = React.useRef(0)
      const active = runs.find((run) => ACTIVE.includes(run.status))

      const load = React.useCallback(async (probe = false, quiet = false) => {
        const generationId = generation.current
        const sequence = ++serial.current
        abortRef.current?.abort()
        const controller = new AbortController(); abortRef.current = controller
        const timer = setTimeout(() => controller.abort(), 20000)
        if (!quiet) setLoading(true)
        try {
          const [inventory, state] = await Promise.all([
            readJson(`/agent-providers?passive=${probe ? '0' : '1'}`, { signal: controller.signal }),
            sessionId ? readJson(`${API}/state?${query({ dshSessionId: sessionId })}`, { signal: controller.signal }) : Promise.resolve({ runs: [] }),
          ])
          if (generation.current !== generationId || serial.current !== sequence) return
          // Structural equality keeps disclosure rows stable during polling.
          setRoutes((old) => {
            const incoming = (inventory.routes ?? []).map((route) => {
              const previous = old.find((entry) => entry.route === route.route)
              return route.passive && previous && !previous.passive ? { ...previous, sessions: route.sessions } : route
            })
            return JSON.stringify(old) === JSON.stringify(incoming) ? old : incoming
          })
          setRuns((old) => JSON.stringify(old) === JSON.stringify(state.runs) ? old : state.runs ?? [])
          setError(null)
        } catch (failure) {
          if (generation.current === generationId && serial.current === sequence && !controller.signal.aborted) setError(failure.message)
          else if (generation.current === generationId && serial.current === sequence && controller.signal.aborted) setError('Request timed out')
        } finally { clearTimeout(timer); if (generation.current === generationId && serial.current === sequence) setLoading(false) }
      }, [sessionId])

      React.useEffect(() => {
        generation.current++; sessionRef.current = sessionId
        setRuns([]); setDetails({}); setPreview(null); setNotice(null); setError(null)
        load(false)
        return () => { generation.current++; abortRef.current?.abort() }
      }, [sessionId, load])
      React.useEffect(() => {
        if (!sessionId || (!tab && !active)) return
        let timer; let stopped = false
        const tick = async () => {
          if (!document.hidden) await load(false, true)
          if (!stopped) timer = setTimeout(tick, active || tab === 'activity' ? 1200 : 5000)
        }
        timer = setTimeout(tick, 1200)
        return () => { stopped = true; clearTimeout(timer) }
      }, [sessionId, tab, Boolean(active), load])

      async function act(action, params, key) {
        if (actions.current.has(key)) return
        actions.current.add(key); setPending((old) => ({ ...old, [key]: true })); setNotice(null)
        const ownGeneration = generation.current
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20000)
        try {
          await readJson(`${API}/${action}?${query(params)}`, { method: 'GET', signal: controller.signal })
          if (ownGeneration === generation.current) { setNotice(t('success')); await load(false) }
        } catch (failure) { if (ownGeneration === generation.current) setNotice(t('failed', { message: failure.message })) }
        finally { clearTimeout(timer); actions.current.delete(key); if (ownGeneration === generation.current) setPending((old) => ({ ...old, [key]: false })) }
      }
      function button(label, onClick, disabled, key) { return h('button', { type: 'button', style: S.button, onClick, disabled, key }, label) }
      function status(value) { return value === 'failed' ? t('failedStatus') : t(value) }
      async function expandTool(run, tool) {
        const key = `${run.id}:${tool.id}`
        if (details[key]) return
        const ownGeneration = generation.current
        try {
          const body = await readJson(`${API}/state?${query({ dshSessionId: sessionId, runId: run.id, toolId: tool.id })}`)
          if (generation.current === ownGeneration) setDetails((old) => ({ ...old, [key]: body }))
        } catch (failure) { if (generation.current === ownGeneration) setDetails((old) => ({ ...old, [key]: { error: failure.message } })) }
      }
      async function viewFile(run, artifact) {
        const ownGeneration = generation.current
        try {
          const body = await readJson(`${API}/state?${query({ dshSessionId: sessionId, runId: run.id, artifactId: artifact.id })}`)
          if (generation.current === ownGeneration) setPreview(body)
        } catch (failure) { if (generation.current === ownGeneration) setNotice(t('failed', { message: failure.message })) }
      }
      function renderRun(run) {
        const busy = ACTIVE.includes(run.status)
        const duration = ((run.endedAt ?? run.updatedAt) - run.startedAt) / 1000
        return h('section', { key: run.id, style: S.card, 'data-run-status': run.status },
          h('div', { style: S.bar }, h('strong', { style: S.grow }, run.title || run.displayName),
            h('span', { style: S.badge }, status(run.status)), h('span', { style: S.muted }, `${duration.toFixed(1)}s`),
            busy ? button(pending[`stop:${run.id}`] ? t('working') : t('stop'), () => act('cancel', { route: run.route, dshSessionId: sessionId, runId: run.id }, `stop:${run.id}`), pending[`stop:${run.id}`]) : null),
          h('div', { style: S.muted }, `${run.displayName} · ${run.cwd}`),
          h('div', { style: S.muted }, `${t('requested')}: ${run.requestedModel ?? 'default'} · ${t('actual')}: ${run.actualModel ?? t('unknown')}`),
          run.failure ? h('div', { role: 'alert', style: S.error }, run.failure.message) : null,
          run.persistenceError ? h('div', { role: 'alert', style: S.error }, t('persistence')) : null,
          ...(run.notices ?? []).map((text, i) => h('div', { key: `n${i}`, style: S.muted }, text)),
          run.context ? h('div', { style: S.muted }, `${run.context.used.toLocaleString()} / ${run.context.size.toLocaleString()} tokens`) : null,
          run.plans.length ? h('div', null, h('div', { style: S.heading }, t('plan')),
            ...run.plans.map((step) => h('div', { key: step.id, style: S.row }, h('span', { style: S.badge }, status(step.status)), h('span', null, step.content)))) : null,
          run.tools.length ? h('div', null, h('div', { style: S.heading }, t('tools')),
            ...run.tools.map((tool) => {
              const key = `${run.id}:${tool.id}`; const detail = details[key]
              return h('details', { key: tool.id, onToggle: (event) => { if (event.currentTarget.open) expandTool(run, tool) } },
                h('summary', { style: S.row }, h('span', { style: S.badge }, status(tool.status)), h('span', null, tool.title)),
                ...(tool.locations ?? []).map((location, i) => h('div', { key: i, style: S.muted }, location.path)),
                detail ? h('div', null,
                  detail.error ? h('div', { style: S.error }, detail.error) : null,
                  detail.input ? h('div', null, t('input'), h('pre', { style: S.pre }, detail.input)) : null,
                  detail.output ? h('div', null, t('output'), h('pre', { style: S.pre }, detail.output)) : null,
                  detail.content ? h('pre', { style: S.pre }, JSON.stringify(detail.content, null, 2)) : null,
                  !detail.input && !detail.output && !detail.content && !detail.error ? t('noDetail') : null) : h('span', { style: S.muted }, t('loading')))
            })) : null,
          run.toolsTruncated ? h('div', { style: S.muted }, t('truncated')) : null,
          run.artifacts.length ? h('div', null, h('div', { style: S.heading }, t('result')),
            ...run.artifacts.map((artifact) => h('div', { key: artifact.id, style: S.row },
              h('span', { style: S.grow }, artifact.path), h('span', { style: S.badge }, status(artifact.status)),
              artifact.status === 'verified' ? button(t('preview'), () => viewFile(run, artifact)) : null))) : null,
          !busy && run.configOptions.length ? h('details', null, h('summary', null, t('config')),
            ...run.configOptions.filter((option) => option.type === 'select' && option.category !== 'model').map((option) => {
              const key = `${run.route}:${option.id}`
              return h('label', { key: option.id, style: S.row }, option.name ?? option.id,
                h('select', { value: option.currentValue, disabled: Boolean(active) || pending[key],
                  onChange: (event) => act('configure', { route: run.route, dshSessionId: sessionId, configId: option.id, value: event.target.value }, key) },
                  ...(option.options ?? []).flatMap((entry) => entry.options ?? [entry]).map((entry) => h('option', { key: entry.value, value: entry.value }, entry.name ?? entry.value))))
            })) : null)
      }
      return h('div', { style: S.root, 'data-agent-providers': '' },
        h('div', { style: S.bar }, h('strong', null, t('title')), active ? h('span', { style: S.badge, role: 'status' }, status(active.status)) : null,
          h('span', { style: S.grow }), button(t('activity'), () => { const next = tab === 'activity' ? null : 'activity'; setTab(next); if (next) load(false) }, false),
          button(t('manage'), () => { const next = tab === 'sessions' ? null : 'sessions'; setTab(next); if (next) load(true) }, false),
          button(loading ? t('loading') : t('refresh'), () => load(tab === 'sessions'), loading)),
        error ? h('div', { role: 'alert', style: S.error }, t('stale', { message: error })) : null,
        notice ? h('div', { role: 'status', style: S.muted }, notice) : null,
        preview ? h('section', { style: S.card, 'aria-label': preview.path }, h('div', { style: S.bar }, h('strong', { style: S.grow }, preview.path),
          button(t('previewClose'), () => setPreview(null))), preview.changedSinceVerified ? h('div', { style: S.error }, t('changed')) : null,
          h('pre', { style: S.pre }, preview.text)) : null,
        tab === 'activity' ? h('div', { style: S.panel }, runs.length ? runs.slice(0, 20).map(renderRun) : h('div', { style: S.muted }, t('empty'))) : null,
        tab === 'sessions' ? h('div', { style: S.panel }, routes.length ? routes.map((route) => {
          const sessions = [...route.sessions].sort((a, b) => Number(b.dshSessionId === sessionId) - Number(a.dshSessionId === sessionId))
          const bound = sessions.find((row) => row.dshSessionId === sessionId)
          return h('section', { key: route.route, style: S.card },
            h('div', { style: S.bar }, h('strong', { style: S.grow }, route.displayName),
              bound && route.capabilities.includes('fork') ? button(t('fork'), () => act('fork', { route: route.route, dshSessionId: sessionId }, `fork:${route.route}`), Boolean(active) || pending[`fork:${route.route}`]) : null),
            route.error ? h('div', { style: S.error }, route.error) : null,
            route.passive ? h('div', { style: S.muted }, t('passive')) : null,
            ...sessions.slice(0, 100).map((session, index) => {
              const key = `${route.route}:${session.sessionId}`
              return h('div', { key: session.sessionId, style: S.row }, h('span', { style: S.grow }, session.title || `${route.displayName} ${index + 1}`),
                session.dshSessionId ? h('span', { style: S.badge }, session.dshSessionId === sessionId ? t('bound') : t('linked')) : null,
                session.forkedFrom ? h('span', { style: S.badge }, t('branch')) : null,
                !route.passive ? button(pending[key] ? t('working') : t('close'), () => act('close', { route: route.route, sessionId: session.sessionId }, key), Boolean(active) || pending[key]) : null,
                route.capabilities.includes('delete') ? button(t('delete'), () => { if (window.confirm(t('confirmDelete'))) act('delete', { route: route.route, sessionId: session.sessionId }, key) }, Boolean(active) || pending[key]) : null)
            }))
        }) : h('div', { style: S.muted }, t('noRoutes'))) : null)
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = translator(ctx)
        ctx.effect(() => ctx.locale.register('agent-providers', DICT), 'agent-providers: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'agent-providers', order: 20, inject: (sessionId) => ({ sessionId }),
        }, (props) => h(AgentWorkspace, { ...props, t })))
      },
    }
  },
})
