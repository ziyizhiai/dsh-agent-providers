window.__ModuleLoader__.load({
  id: 'dsh-agent-providers',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'agent-providers'
    const ENDPOINT = '/agent-providers'
    const ACTION_ENDPOINT = '/agent-providers/api'

    const DICT = {
      zh: {
        'title': 'Agent 会话',
        'summary': '{count} 个会话',
        'refresh': '刷新',
        'manage': '管理',
        'hide': '收起',
        'loading': '正在读取…',
        'empty': '这个 agent 还没有存下来的会话。',
        'unsupported': '这个后端不支持列举会话。',
        'unavailable': '无法连接：{message}',
        'close': '关闭',
        'delete': '删除',
        'confirmDelete': '删除后无法恢复，确定？',
        'bound': '当前会话',
        'forkHere': '分叉当前对话',
        'failed': '操作失败：{message}',
        'noRoutes': '还没有配置 agent 供应商。',
      },
      en: {
        'title': 'Agent sessions',
        'summary': '{count} session(s)',
        'refresh': 'Refresh',
        'manage': 'Manage',
        'hide': 'Hide',
        'loading': 'Loading…',
        'empty': 'This agent has no stored sessions yet.',
        'unsupported': 'This backend cannot list sessions.',
        'unavailable': 'Unreachable: {message}',
        'close': 'Close',
        'delete': 'Delete',
        'confirmDelete': 'Delete cannot be undone. Continue?',
        'bound': 'this conversation',
        'forkHere': 'Fork this chat',
        'failed': 'Action failed: {message}',
        'noRoutes': 'No agent provider is configured yet.',
      },
    }

    function makeTranslator() {
      const fallback = (key, vars) => {
        const language = (typeof document !== 'undefined' && document.documentElement.lang || 'en').toLowerCase()
        const dict = language.startsWith('zh') ? DICT.zh : DICT.en
        const text = dict[key] ?? DICT.en[key] ?? key
        return vars === undefined
          ? text
          : text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
      }
      return fallback
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '6px 10px',
        fontSize: 12,
        color: 'inherit',
        borderTop: '1px solid rgba(127,127,127,0.25)',
      },
      bar: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      label: { opacity: 0.75, whiteSpace: 'nowrap' },
      route: { opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      spacer: { flex: 1 },
      button: {
        font: 'inherit',
        fontSize: 12,
        color: 'inherit',
        background: 'transparent',
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: 6,
        padding: '1px 8px',
        cursor: 'pointer',
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 180,
        overflowY: 'auto',
        margin: 0,
        padding: 0,
        listStyle: 'none',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: '2px 0' },
      rowHere: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        padding: '2px 4px',
        borderRadius: 4,
        background: 'rgba(127,127,127,0.14)',
      },
      id: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', opacity: 0.8, whiteSpace: 'nowrap' },
      title: { opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: {
        fontSize: 10,
        padding: '0 5px',
        borderRadius: 4,
        border: '1px solid rgba(127,127,127,0.35)',
        opacity: 0.8,
        whiteSpace: 'nowrap',
      },
      note: { opacity: 0.6, padding: '2px 0' },
    }

    function AgentSessionStrip(props) {
      const t = props.t
      const here = props.sessionId
      const [state, setState] = React.useState({ status: 'loading', routes: [], error: null })
      const [open, setOpen] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(() => {
        setState((current) => ({ ...current, status: 'loading', error: null }))
        fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((body) => setState({ status: 'ready', routes: body.routes ?? [], error: null }))
          .catch((error) => setState({ status: 'error', routes: [], error: error.message }))
      }, [])

      React.useEffect(() => { load() }, [load])
      // Opening the panel is the moment the list matters, and an agent session
      // may have been created since mount.
      React.useEffect(() => { if (open) load() }, [open])

      const act = (action, params) => {
        setNotice(null)
        // The host serves plugin routes for GET only, so the action travels in
        // the query; the header is what keeps a cross-site page from doing this.
        const query = Object.entries(params)
          .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
          .join('&')
        fetch(`${ACTION_ENDPOINT}/${action}?${query}`, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-dsh-agent-providers': '1',
          },
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
            load()
          })
          .catch((error) => setNotice(t('failed', { message: error.message })))
      }

      const total = state.routes.reduce((sum, route) => sum + route.sessions.length, 0)

      return h('div', { style: S.root, 'data-agent-providers': '' },
        h('div', { style: S.bar },
          h('span', { style: S.label }, t('title')),
          h('span', { style: S.route },
            state.status === 'loading' ? t('loading') : t('summary', { count: total })),
          h('span', { style: S.spacer }),
          h('button', { type: 'button', style: S.button, onClick: load }, t('refresh')),
          h('button', {
            type: 'button',
            style: S.button,
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          }, open ? t('hide') : t('manage')),
        ),

        notice !== null ? h('div', { style: S.note }, notice) : null,

        open
          ? state.status === 'ready' && state.routes.length === 0
            ? h('div', { style: S.note }, t('noRoutes'))
            : state.routes.map((route) => {
              const bound = route.sessions.find((session) => session.dshSessionId !== undefined && session.dshSessionId === here)
              return h('div', { key: route.route, style: S.list },
                h('div', { style: S.bar },
                  h('span', { style: S.label }, route.displayName ?? route.route),
                  h('span', { style: S.route },
                    route.error !== undefined
                      ? t('unavailable', { message: route.error })
                      : route.capabilities.includes('list')
                        ? t('summary', { count: route.sessions.length })
                        : t('unsupported')),
                  h('span', { style: S.spacer }),
                  bound !== undefined && route.capabilities.includes('fork')
                    ? h('button', {
                        type: 'button',
                        style: S.button,
                        onClick: () => act('fork', { route: route.route, dshSessionId: here }),
                      }, t('forkHere'))
                    : null,
                ),
                route.sessions.map((session) => h('div', {
                  key: session.sessionId,
                  style: session.dshSessionId === here ? S.rowHere : S.row,
                },
                  h('span', { style: S.id }, session.sessionId.slice(0, 18)),
                  session.dshSessionId !== undefined ? h('span', { style: S.badge }, t('bound')) : null,
                  h('span', { style: S.title }, session.title ?? ''),
                  h('span', { style: S.spacer }),
                  h('button', {
                    type: 'button',
                    style: S.button,
                    onClick: () => act('close', { route: route.route, sessionId: session.sessionId }),
                  }, t('close')),
                  route.capabilities.includes('delete')
                    ? h('button', {
                        type: 'button',
                        style: S.button,
                        onClick: () => {
                          if (typeof window !== 'undefined' && window.confirm(t('confirmDelete'))) {
                            act('delete', { route: route.route, sessionId: session.sessionId })
                          }
                        },
                      }, t('delete'))
                    : null,
                )),
                route.sessions.length === 0 && route.error === undefined
                  ? h('div', { style: S.note }, t('empty'))
                  : null,
              )
            })
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // Prefer the harness locale service so the panel follows the same
        // language switch as the rest of the product; fall back to reading
        // document.lang when the service exposes no binder.
        const bound = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : undefined
        const own = makeTranslator()
        const t = bound === undefined
          ? own
          : (key, vars) => {
              const text = bound(key, vars)
              return text === key ? own(key, vars) : text
            }
        ctx.effect(() => {
          const dispose = ctx.locale.register(NS, DICT)
          return () => {
            if (typeof dispose === 'function') dispose()
          }
        }, 'agent-providers: dictionaries')
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'agent-providers',
          order: 20,
          // The slot hands the registry a session id; the panel needs it to say
          // which row belongs to the conversation on screen.
          inject: (sessionId) => ({ sessionId }),
        }, (slotProps) => h(AgentSessionStrip, { ...slotProps, t })))
      },
    }
  },
})
