window.__ModuleLoader__.load({
  id: 'dsh-agent-providers',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/agent-providers/api'
    const HEADERS = { accept: 'application/json', 'x-dsh-agent-providers': '1' }
    const ACTIVE = ['queued', 'starting', 'running', 'waiting', 'finalizing', 'cancelling']
    const DICT = {
      zh: {
        inspect: '核对执行证据', acknowledge: '我已核对，允许后续回合', reviewed: '已人工核对（不代表任务成功）', connection: '检查连接', connected: '连接检查完成；未重跑任务', recipeOnly: '仅检查CLI配置，未验证登录或可执行性',
        reviewBoundary: '仅检查Agent报告的文件；不执行命令、不判断任务成功。请同时核对工具详情及外部系统结果。',
        unknownBoundary: '上一轮结果未知。核对证据并确认后才能发送下一轮；停止不代表撤销已执行操作。',
        fileExists: '文件存在', fileUnavailable: '文件不可用', noEvidence: '没有可核对的文件，请检查工具详情与外部系统。',
        retrySave: '仅重试保存', saveComplete: '记录已保存；没有重跑任务', saveFailed: '保存仍失败，可导出诊断；不要重跑已执行任务', diagnostics: '查看诊断', downloadDiagnostic: '导出诊断JSON', diagnosticTitle: '当前会话诊断（不含对话正文和原始工具输出）', queueTime: '排队 {seconds}s', executeTime: '执行 {seconds}s', backendDefault: '使用后端默认',
        error_EXECUTION_UNKNOWN: '未能确认停止后的执行结果。请核对工具、文件和外部系统，不要直接重跑。',
        error_BUSY: '会话正在运行或排队，请先停止。', error_REVIEW_REQUIRED: '请先核对上一轮结果未知的执行并确认。', error_STATE_CONFLICT: '记录被另一实例修改，已拒绝覆盖；请使用独立状态目录。', error_STATE_BUSY: '另一实例正在写记录，请稍后重试。', error_MODEL_UNCONFIRMED: '后端未确认所选模型，本轮未开始执行。', error_CONFIG_UNCONFIRMED: '后端未确认配置，请检查诊断。', error_STALE_SESSION: '账号配置已改变，旧会话不能继续配置。', error_UNSUPPORTED: '当前后端不支持此操作。', error_NOT_FOUND: '执行记录不存在或不属于当前会话。', error_PROCESS_INTERRUPTED: '共享Agent进程已中断，执行结果可能未知。', error_PROCESS_LOST: '上次进程已退出，请核对已执行操作。', error_ABORTED: '运行已停止，已执行操作不会自动撤销。',
        title: 'Agent 工作区', manage: '会话', activity: '执行记录', hide: '收起', refresh: '刷新', loading: '正在刷新…',
        currentConfig: '当前会话选项', historicalConfig: '本轮配置（只读）', cancelling: '正在停止', unknownResult: '执行结果未知',
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
        inspect: 'Inspect execution evidence', acknowledge: 'I reviewed it; allow future turns', reviewed: 'Human reviewed (not proof of success)', connection: 'Check connection', connected: 'Connection checked; no task restarted', recipeOnly: 'CLI recipe only; login and executable were not verified',
        reviewBoundary: 'Only reported files are checked. No commands run and no task success is inferred. Also inspect tool details and external systems.', unknownBoundary: 'Previous execution is unknown. Inspect and acknowledge it before a new turn. Stop does not undo executed actions.', fileExists: 'File exists', fileUnavailable: 'Unavailable', noEvidence: 'No file evidence; inspect tools and external systems.', retrySave: 'Retry saving only', saveComplete: 'Saved; no task restarted', saveFailed: 'Saving failed; export diagnostics and do not rerun executed tasks', diagnostics: 'View diagnostics', downloadDiagnostic: 'Export diagnostic JSON', diagnosticTitle: 'Conversation diagnostics (no transcript or raw tool bodies)', queueTime: 'Queued {seconds}s', executeTime: 'Execution {seconds}s', backendDefault: 'Backend default',
        error_EXECUTION_UNKNOWN: 'Stop could not confirm the execution result. Inspect tools, files and external systems before proceeding.',
        error_BUSY: 'Session is running or queued; stop it first.', error_REVIEW_REQUIRED: 'Inspect and acknowledge the previous unknown execution first.', error_STATE_CONFLICT: 'Another instance changed the record; overwrite refused.', error_STATE_BUSY: 'Another instance is writing state; retry later.', error_MODEL_UNCONFIRMED: 'Backend did not confirm model; execution was not started.', error_CONFIG_UNCONFIRMED: 'Backend did not confirm configuration.', error_STALE_SESSION: 'Account configuration changed; old session is stale.', error_UNSUPPORTED: 'Backend does not support this operation.', error_NOT_FOUND: 'Record is missing or belongs to another conversation.', error_PROCESS_INTERRUPTED: 'Shared process interrupted; execution result may be unknown.', error_PROCESS_LOST: 'Previous process is gone; inspect executed actions.', error_ABORTED: 'Stopped; completed actions are not rolled back.',
        title: 'Agent workspace', manage: 'Sessions', activity: 'Activity', hide: 'Hide', refresh: 'Refresh', loading: 'Refreshing…',
        currentConfig: 'Current session options', historicalConfig: 'Turn configuration (read only)', cancelling: 'Stopping', unknownResult: 'Execution result unknown',
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
      if (!response.ok) { const error = new Error(body.error?.message ?? `HTTP ${response.status}`); error.code = body.error?.code; throw error }
      return body
    }
    function query(params) { return new URLSearchParams(params).toString() }

    function AgentWorkspace({ sessionId, t }) {
      const [tab, setTab] = React.useState(null)
      const [routes, setRoutes] = React.useState([])
      const [runs, setRuns] = React.useState([])
      const [configuration, setConfiguration] = React.useState([])
      const [clock, setClock] = React.useState(Date.now())
      const detailRef = React.useRef({})
      const expanded = React.useRef(new Map())
      const detailRequests = React.useRef(new Set())
      const probeBusy = React.useRef(false)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [pending, setPending] = React.useState({})
      const [details, setDetails] = React.useState({})
      const [preview, setPreview] = React.useState(null)
      const [diagnostic, setDiagnostic] = React.useState(null)
      const [connection, setConnection] = React.useState({})
      const generation = React.useRef(0)
      const abortRef = React.useRef(null)
      const actions = React.useRef(new Set())
      const sessionRef = React.useRef(sessionId)
      const serial = React.useRef(0)
      const active = runs.find((run) => ACTIVE.includes(run.status))

      function errorText(failure) { const key = `error_${failure.code}`; const text = t(key); return text !== key ? text : failure.message }
      const load = React.useCallback(async (probe = false, quiet = false) => {
        if (quiet && probeBusy.current) return
        if (probe) probeBusy.current = true
        const generationId = generation.current
        const sequence = ++serial.current
        abortRef.current?.abort()
        const controller = new AbortController(); abortRef.current = controller
        const timer = setTimeout(() => controller.abort(), 20000)
        if (!quiet) setLoading(true)
        try {
          const alive = () => generation.current === generationId && serial.current === sequence
          const stateRead = sessionId ? readJson(`${API}/state?${query({ dshSessionId: sessionId })}`, { signal: controller.signal }) : Promise.resolve({ runs: [] })
          const inventoryRead = readJson(`/agent-providers?passive=${probe ? '0' : '1'}`, { signal: controller.signal })
          await Promise.all([
            stateRead.then(state => {
              if (!alive()) return
              setRuns(old => JSON.stringify(old) === JSON.stringify(state.runs) ? old : state.runs ?? [])
              setConfiguration(state.configuration ?? [])
              setClock(Date.now())
            }),
            inventoryRead.then(inventory => {
              if (!alive()) return
              setRoutes(old => {
                const incoming = (inventory.routes ?? []).map(route => {
                  const previous = old.find(entry => entry.route === route.route)
                  return route.passive && previous && !previous.passive ? { ...previous, sessions: route.sessions } : route
                })
                return JSON.stringify(old) === JSON.stringify(incoming) ? old : incoming
              })
            }),
          ])
          if (alive()) setError(null)
        } catch (failure) {
          if (generation.current === generationId && serial.current === sequence && !controller.signal.aborted) setError(errorText(failure))
          else if (generation.current === generationId && serial.current === sequence && controller.signal.aborted) setError('Request timed out')
        } finally { clearTimeout(timer); if (probe) probeBusy.current = false; if (generation.current === generationId && serial.current === sequence) setLoading(false) }
      }, [sessionId])

      React.useEffect(() => {
        generation.current++; sessionRef.current = sessionId
        setDiagnostic(null); setConnection({})
        setRuns([]); setConfiguration([]); setDetails({}); detailRef.current = {}; expanded.current.clear(); setPreview(null); setNotice(null); setError(null)
        load(false)
        return () => { generation.current++; abortRef.current?.abort() }
      }, [sessionId, load])
      React.useEffect(() => {
        if (!sessionId) return
        let timer; let stopped = false
        const tick = async () => {
          if (!document.hidden) await load(false, true)
          if (!stopped) timer = setTimeout(tick, active || tab === 'activity' ? 1200 : 5000)
        }
        timer = setTimeout(tick, 1200)
        return () => { stopped = true; clearTimeout(timer) }
      }, [sessionId, tab, Boolean(active), load])

      React.useEffect(() => {
        for (const run of runs) for (const tool of run.tools) if (expanded.current.has(`${run.id}:${tool.id}`)) expandTool(run, tool)
      }, [runs])
      React.useEffect(() => {
        if (!active) return
        const timer = setInterval(() => { if (!document.hidden) setClock(Date.now()) }, 1000)
        return () => clearInterval(timer)
      }, [Boolean(active)])

      async function act(action, params, key) {
        if (actions.current.has(key)) return
        actions.current.add(key); setPending((old) => ({ ...old, [key]: true })); setNotice(null)
        const ownGeneration = generation.current
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20000)
        try {
          const result = await readJson(`${API}/${action}?${query(params)}`, { method: 'GET', signal: controller.signal })
          if (ownGeneration === generation.current) {
            if (action === 'connection') { setConnection(old => ({ ...old, [params.route]: result })); setNotice(t(result.verified === 'recipe-only' ? 'recipeOnly' : 'connected')) }
            else if (action === 'retry-save') setNotice(t(result.saved ? 'saveComplete' : 'saveFailed'))
            else if (result.persistence?.saved === false) setNotice(t('saveFailed'))
            else setNotice(t('success'))
            await load(false)
          }
        } catch (failure) { if (ownGeneration === generation.current) setNotice(t('failed', { message: errorText(failure) })) }
        finally { clearTimeout(timer); actions.current.delete(key); if (ownGeneration === generation.current) setPending((old) => ({ ...old, [key]: false })) }
      }
      function button(label, onClick, disabled, key) { return h('button', { type: 'button', style: S.button, onClick, disabled, key }, label) }
      function status(value) { return value === 'failed' ? t('failedStatus') : value === 'unknown' ? t('unknownResult') : t(value) }
      async function expandTool(run, tool) {
        const key = `${run.id}:${tool.id}`
        if (detailRequests.current.has(key)) return
        if (detailRef.current[key] && detailRef.current[key].revision === tool.revision && !detailRef.current[key].error) return
        detailRequests.current.add(key)
        const ownGeneration = generation.current
        try {
          const body = await readJson(`${API}/state?${query({ dshSessionId: sessionId, runId: run.id, toolId: tool.id })}`)
          if (generation.current === ownGeneration) {
            detailRef.current[key] = { ...body, revision: body.revision ?? tool.revision }
            setDetails(old => ({ ...old, [key]: detailRef.current[key] }))
          }
        } catch (failure) { if (generation.current === ownGeneration) setDetails(old => ({ ...old, [key]: { ...old[key], error: failure.message } })) }
        finally { detailRequests.current.delete(key) }
      }
      async function viewFile(run, artifact) {
        const ownGeneration = generation.current
        try {
          const body = await readJson(`${API}/state?${query({ dshSessionId: sessionId, runId: run.id, artifactId: artifact.id })}`)
          if (generation.current === ownGeneration) setPreview(body)
        } catch (failure) { if (generation.current === ownGeneration) setNotice(t('failed', { message: errorText(failure) })) }
      }
      async function viewDiagnostics() {
        const ownGeneration = generation.current
        try {
          const body = await readJson(`${API}/state?${query({ dshSessionId: sessionId, diagnostics: '1' })}`)
          if (generation.current === ownGeneration) setDiagnostic(body)
        } catch (failure) { if (generation.current === ownGeneration) setNotice(t('failed', { message: errorText(failure) })) }
      }
      function downloadDiagnostics() {
        if (!diagnostic) return
        const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }))
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'agent-diagnostics.json'; anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      function renderReview(run) {
        const uncertain = run.status === 'unknown' || (run.status === 'interrupted' && run.failure?.code === 'PROCESS_LOST')
        if (!uncertain && !run.review) return null
        return h('div', { style: S.card, 'data-execution-review': '' },
          h('p', { style: S.error }, t(run.review?.acknowledgedAt ? 'reviewed' : 'unknownBoundary')),
          h('p', { style: S.muted }, t('reviewBoundary')),
          button(t('inspect'), () => act('inspect', { dshSessionId: sessionId, route: run.route, runId: run.id }, `inspect:${run.id}`), Boolean(active) || pending[`inspect:${run.id}`]),
          run.review?.checkedAt ? h('div', null,
            run.review.evidence?.length ? run.review.evidence.map((entry, i) => h('div', { key: i, style: S.row }, entry.path, t(entry.state === 'exists' ? 'fileExists' : 'fileUnavailable'))) : h('p', null, t('noEvidence')),
            !run.review.acknowledgedAt ? button(t('acknowledge'), () => act('acknowledge', { dshSessionId: sessionId, route: run.route, runId: run.id }, `ack:${run.id}`), Boolean(active) || pending[`ack:${run.id}`]) : null) : null)
      }
      function renderRun(run) {
        const busy = ACTIVE.includes(run.status)
        const queueSeconds = Math.max(0, ((run.executionStartedAt ?? run.endedAt ?? clock) - run.startedAt) / 1000)
        const duration = run.executionStartedAt ? Math.max(0, ((run.endedAt ?? clock) - run.executionStartedAt) / 1000) : 0
        return h('section', { key: run.id, style: S.card, 'data-run-status': run.status },
          h('div', { style: S.bar }, h('strong', { style: S.grow }, run.title || run.displayName),
            h('span', { style: S.badge }, status(run.status)), h('span', { style: S.muted }, t('queueTime', { seconds: queueSeconds.toFixed(1) })), h('span', { style: S.muted }, t('executeTime', { seconds: duration.toFixed(1) })),
            busy ? button(pending[`stop:${run.id}`] ? t('working') : t('stop'), () => act('cancel', { route: run.route, dshSessionId: sessionId, runId: run.id }, `stop:${run.id}`), pending[`stop:${run.id}`]) : null),
          h('div', { style: S.muted }, `${run.displayName} · ${run.cwd}`),
          h('div', { style: S.muted }, `${t('requested')}: ${run.requestedModel && run.requestedModel !== '__dsh_backend_default__' ? run.requestedModel : t('backendDefault')} · ${t('actual')}: ${run.actualModel ?? t('unknown')}`),
          run.failure ? h('div', { role: 'alert', style: S.error }, errorText(run.failure)) : null,
          renderReview(run),
          run.persistenceError ? h('div', { role: 'alert', style: S.error }, t('persistence')) : null,
          ...(run.notices ?? []).map((text, i) => h('div', { key: `n${i}`, style: S.muted }, text)),
          run.context ? h('div', { style: S.muted }, `${run.context.used.toLocaleString()} / ${run.context.size.toLocaleString()} tokens`) : null,
          run.plans.length ? h('div', null, h('div', { style: S.heading }, t('plan')),
            ...run.plans.map((step) => h('div', { key: step.id, style: S.row }, h('span', { style: S.badge }, status(step.status)), h('span', null, step.content)))) : null,
          run.tools.length ? h('div', null, h('div', { style: S.heading }, t('tools')),
            ...run.tools.map((tool) => {
              const key = `${run.id}:${tool.id}`; const detail = details[key]
              return h('details', { key: tool.id, onToggle: event => {
                if (event.currentTarget.open) { expanded.current.set(key, true); expandTool(run, tool) }
                else expanded.current.delete(key)
              } },
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
          run.configOptions.length ? h('details', null, h('summary', null, t('historicalConfig')),
            ...run.configOptions.map(option => h('div', { key: option.id, style: S.row }, `${option.name ?? option.id}: ${String(option.currentValue ?? '')}`))) : null)
      }
      function renderConfiguration(row) {
        if (!row.configurable) return null
        return h('section', { key: row.route, style: S.card }, h('strong', null, `${row.displayName} · ${t('currentConfig')}`),
          ...row.options.filter(option => ['select', 'boolean'].includes(option.type) && option.category !== 'model' && option.id !== 'model').map(option => {
            const key = `${row.route}:${option.id}`
            const disabled = Boolean(active) || pending[key]
            const send = value => act('configure', { route: row.route, dshSessionId: sessionId, configId: option.id, value: String(value) }, key)
            const control = option.type === 'select' ? h('select', { value: option.currentValue, disabled, onChange: event => send(event.target.value) },
              ...(option.options ?? []).flatMap(entry => entry.options ?? [entry]).map(entry => h('option', { key: entry.value, value: entry.value }, entry.name ?? entry.value)))
              : h('input', { type: 'checkbox', checked: Boolean(option.currentValue), disabled, onChange: event => send(event.target.checked) })
            return h('label', { key: option.id, style: S.row }, option.name ?? option.id, control)
          }))
      }
      return h('div', { style: S.root, 'data-agent-providers': '' },
        h('div', { style: S.bar }, h('strong', null, t('title')), active ? h('span', { style: S.badge, role: 'status' }, status(active.status)) : null,
          h('span', { style: S.grow }), button(t('activity'), () => { const next = tab === 'activity' ? null : 'activity'; setTab(next); if (next) load(false) }, false),
          button(t('manage'), () => { const next = tab === 'sessions' ? null : 'sessions'; setTab(next); if (next) load(true) }, false),
          button(loading ? t('loading') : t('refresh'), () => load(tab === 'sessions'), loading),
          button(t('diagnostics'), viewDiagnostics, !sessionId),
          runs.some(run => run.persistenceError || run.bindingPersistenceError) ? button(t('retrySave'), () => act('retry-save', { dshSessionId: sessionId }, 'retry-save'), Boolean(active) || pending['retry-save']) : null),
        error ? h('div', { role: 'alert', style: S.error }, t('stale', { message: error })) : null,
        notice ? h('div', { role: 'status', style: S.muted }, notice) : null,
        diagnostic ? h('section', { style: S.card, 'data-diagnostic': '' }, h('strong', null, t('diagnosticTitle')),
          button(t('downloadDiagnostic'), downloadDiagnostics), button(t('previewClose'), () => setDiagnostic(null)),
          h('pre', { style: S.pre }, JSON.stringify(diagnostic, null, 2))) : null,
        preview ? h('section', { style: S.card, 'aria-label': preview.path }, h('div', { style: S.bar }, h('strong', { style: S.grow }, preview.path),
          button(t('previewClose'), () => setPreview(null))), preview.changedSinceVerified ? h('div', { style: S.error }, t('changed')) : null,
          h('pre', { style: S.pre }, preview.text)) : null,
        tab === 'activity' ? h('div', { style: S.panel }, ...configuration.map(renderConfiguration), runs.length ? runs.slice(0, 20).map(renderRun) : h('div', { style: S.muted }, t('empty'))) : null,
        tab === 'sessions' ? h('div', { style: S.panel }, routes.length ? routes.map((route) => {
          const sessions = [...route.sessions].sort((a, b) => Number(b.dshSessionId === sessionId) - Number(a.dshSessionId === sessionId))
          const bound = sessions.find((row) => row.dshSessionId === sessionId)
          return h('section', { key: route.route, style: S.card },
            h('div', { style: S.bar }, h('strong', { style: S.grow }, route.displayName),
              button(t('connection'), () => act('connection', { dshSessionId: sessionId, route: route.route }, `connection:${route.route}`), Boolean(active) || pending[`connection:${route.route}`]),
              bound && route.capabilities.includes('fork') ? button(t('fork'), () => act('fork', { route: route.route, dshSessionId: sessionId }, `fork:${route.route}`), Boolean(active) || pending[`fork:${route.route}`]) : null),
            route.error ? h('div', { style: S.error }, route.error) : null,
            connection[route.route] ? h('div', { style: S.muted }, t(connection[route.route].verified === 'recipe-only' ? 'recipeOnly' : 'connected')) : null,
            route.passive ? h('div', { style: S.muted }, t('passive')) : null,
            ...sessions.slice(0, 100).map((session, index) => {
              const key = `${route.route}:${session.sessionId}`
              return h('div', { key: session.sessionId, style: S.row }, h('span', { style: S.grow }, session.title || `${route.displayName} ${index + 1}`),
                session.dshSessionId ? h('span', { style: S.badge }, session.dshSessionId === sessionId ? t('bound') : t('linked')) : null,
                session.forkedFrom ? h('span', { style: S.badge }, t('branch')) : null,
                route.capabilities.includes('close') && !route.passive ? button(pending[key] ? t('working') : t('close'), () => act('close', { route: route.route, sessionId: session.sessionId }, key), Boolean(active) || pending[key]) : null,
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
