/**
 * The HTTP surface behind the sidebar panel.
 *
 * The host web server dispatches plugin routes for GET and HEAD only — a
 * mutation sent as POST is answered `405 allow: GET, HEAD` before any plugin
 * code runs. So both routes are reads at the transport level, and a mutation
 * carries its arguments in the query string:
 *
 *     GET /agent-providers/api/close?route=opencode-go&sessionId=ses_…
 *
 * That is deliberately impure HTTP, and it is safe because every mutation also
 * requires `x-dsh-agent-providers: 1`. A cross-site page cannot set a custom
 * header on a navigation, image, or form submission, and a `fetch` that tries
 * would need a CORS preflight this server never grants — so a random page
 * cannot drive a close or a delete on the local harness. A same-origin script
 * can, which is exactly the sidebar panel.
 *
 * @module dsh-agent-providers/http
 */

import { isIP } from 'node:net'
import { redactValue, redactText } from './redact.js'

/** Route prefix claimed by this plugin. */
export const ROUTE_PREFIX = '/agent-providers'

/**
 * Prefix the actions live under.
 *
 * A prefix route matches `p` and `p/<anything>` and its `path` must carry no
 * trailing slash, so the actions need their own sub-path: registering
 * `/agent-providers` as the prefix would collide with the inventory route.
 */
export const ACTION_PREFIX = `${ROUTE_PREFIX}/api`

/** Header a same-origin caller must send on a mutation. */
export const ACTION_HEADER = 'x-dsh-agent-providers'

/** Largest accepted request body. */
const BODY_LIMIT = 8_192

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Reject anything that is not a same-origin request with the action header. */
function guard(request, { mutation }) {
  if (mutation) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: { code: 'METHOD', message: 'use GET (the server refuses other methods to plugins)' } })
    }
    if (request.headers.get(ACTION_HEADER) !== '1') {
      return json(403, {
        error: {
          code: 'ACTION_HEADER',
          message: `send "${ACTION_HEADER}: 1"; a cross-site page cannot, which is the point`,
        },
      })
    }
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: { code: 'METHOD', message: 'the inventory is a GET' } })
  }
  // A browser sets Origin on every cross-site request; admit only our own.
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(request.url).origin) {
    return json(403, { error: { code: 'ORIGIN', message: `origin ${origin} is not this harness` } })
  }
  return undefined
}

/** Read a small JSON body without buffering an unbounded request. */
async function readJson(request) {
  const text = await request.text()
  if (text.length > BODY_LIMIT) throw new Error(`request body exceeds ${BODY_LIMIT} bytes`)
  if (text.trim().length === 0) return {}
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object')
  }
  return value
}

/**
 * Answer the inventory read.
 * @param {import('./sessions.js').SessionAdmin} admin
 * @param {Request} request
 */
export async function handleInventory(admin, request) {
  const denied = guard(request, { mutation: false })
  if (denied !== undefined) return denied
  try {
    return json(200, { routes: await admin.inventory({ passive: new URL(request.url).searchParams.get('passive') === '1' }) })
  } catch (error) {
    return json(500, { error: { code: 'INVENTORY', message: redactText(error.message) } })
  }
}

/**
 * Answer one mutation: `/close`, `/delete` or `/fork`.
 *
 * Arguments come from the query string; a JSON body is also accepted so the
 * same handler keeps working if the server ever dispatches POST to plugins.
 *
 * @param {import('./sessions.js').SessionAdmin} admin
 * @param {Request} request
 */
export async function handleAction(admin, request) {
  const denied = guard(request, { mutation: true })
  if (denied !== undefined) return denied

  const url = new URL(request.url)
  const action = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  let body
  try {
    body = request.method === 'POST' ? await readJson(request) : {}
  } catch (error) {
    return json(400, { error: { code: 'BODY', message: redactText(error.message) } })
  }
  const field = (name) => {
    const value = typeof body[name] === 'string' ? body[name] : url.searchParams.get(name) ?? undefined
    if (value !== undefined && (value.length === 0 || value.length > 2048 || /[\u0000-\u001f]/.test(value))) throw new Error(`invalid ${name}`)
    return value
  }
  try {
    const route = field('route')
    switch (action) {
      case 'cancel':
      case 'configure': {
        const dshSessionId = field('dshSessionId')
        if (!dshSessionId || !route) return json(400, { error: { code: 'ARGS', message: 'route and dshSessionId are required' } })
        if (action === 'cancel') return json(200, await admin.cancel(dshSessionId, route, field('runId')))
        const configId = field('configId'); const value = field('value')
        if (!configId || value === undefined) return json(400, { error: { code: 'ARGS', message: 'configId and value are required' } })
        return json(200, await admin.configure({ dshSessionId, route, configId, value }))
      }
      case 'fork': {
        // Forking is relative to a DSH Session, so it names that instead of an
        // external id: the branch becomes the conversation's new target.
        const dshSessionId = field('dshSessionId')
        if (dshSessionId === undefined) {
          return json(400, { error: { code: 'ARGS', message: 'dshSessionId is required to fork' } })
        }
        return json(200, await admin.fork({
          route: route ?? (await admin.routeForSession(dshSessionId)),
          dshSessionId,
        }))
      }
      case 'close':
      case 'delete': {
        const sessionId = field('sessionId')
        if (route === undefined || sessionId === undefined) {
          return json(400, { error: { code: 'ARGS', message: 'route and sessionId are required' } })
        }
        return action === 'close'
          ? json(200, await admin.close(route, sessionId))
          : json(200, await admin.delete(route, sessionId))
      }
      default:
        return json(404, { error: { code: 'ACTION', message: `unknown action "${action}"` } })
    }
  } catch (error) {
    return json(400, { error: { code: error.code ?? 'ACTION', message: redactText(error.message) } })
  }
}

/**
 * Whether a connection came from this machine.
 *
 * The harness's plugin routes are not behind whatever authentication protects
 * the app shell — a GET to one of them answers 200 while `/` answers 401 — so a
 * deployment exposed beyond loopback would expose this inventory, and its
 * actions, to the network. Refusing non-loopback peers is the cheap correct
 * default; a deployment that needs remote control should put its own
 * authentication in front of it.
 *
 * @param {string | undefined} address - `req.socket.remoteAddress`.
 */
export function isLoopbackPeer(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || (isIP(normalized) === 4 && normalized.startsWith('127.'))
}

/** Adapt a Node request to a Fetch {@link Request} so the handlers stay one shape. */
async function toRequest(req) {
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`
  const url = new URL(req.url ?? '/', origin)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return new Request(url, { method: req.method, headers })
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) break
    chunks.push(chunk)
  }
  return new Request(url, { method: req.method, headers, body: Buffer.concat(chunks) })
}

/** Write a Fetch {@link Response} back through a Node response. */
async function send(res, response) {
  res.statusCode = response.status
  for (const [name, value] of response.headers) res.setHeader(name, value)
  const body = Buffer.from(await response.arrayBuffer())
  res.setHeader('content-length', String(body.byteLength))
  res.end(body)
}

/**
 * Register the panel routes on the host web server.
 *
 * @param {any} ctx - the plugin context, providing `webServer`.
 * @param {import('./sessions.js').SessionAdmin} admin
 * @returns {() => void} disposer
 */
export async function handleState(admin, request) {
  const denied = guard(request, { mutation: false })
  if (denied) return denied
  // Read-only records contain workspace detail; require the same non-simple header.
  if (request.headers.get(ACTION_HEADER) !== '1') return json(403, { error: { code: 'HEADER', message: 'missing client header' } })
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('dshSessionId')
  if (!sessionId || sessionId.length > 2048) return json(400, { error: { code: 'ARGS', message: 'dshSessionId is required' } })
  try {
    const store = admin.adapter.activity
    if (!store) return json(200, { runs: [] })
    if (url.searchParams.has('toolId')) return json(200, await store.detail(sessionId, url.searchParams.get('runId'), url.searchParams.get('toolId')))
    if (url.searchParams.has('artifactId')) return json(200, await store.preview(sessionId, url.searchParams.get('runId'), url.searchParams.get('artifactId')))
    return json(200, { runs: await store.list(sessionId), configuration: await admin.configuration?.(sessionId) ?? [] })
  } catch (error) { return json(400, { error: { code: 'STATE', message: redactText(error.message) } }) }
}

export function registerRoutes(ctx, admin) {
  /** Guard the peer, adapt the request, answer, and never leave a socket open. */
  const serve = (pure) => async (req, res) => {
    try {
      if (!isLoopbackPeer(req.socket?.remoteAddress)) {
        await send(res, json(403, {
          error: { code: 'PEER', message: 'this endpoint only answers connections from this machine' },
        }))
        return
      }
      await send(res, await pure(await toRequest(req)))
    } catch (error) {
      await send(res, json(500, { error: { code: 'INTERNAL', message: redactText(error.message) } }))
    }
  }

  // Both routes own the raw request: the inventory needs the peer address, and
  // a `resource` route cannot see it.
  const disposeList = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX,
    handler: serve((request) => handleInventory(admin, request)),
  })

  const disposeActions = ctx.webServer.register({
    kind: 'prefix',
    path: ACTION_PREFIX,
    handler: serve((request) => new URL(request.url).pathname === `${ACTION_PREFIX}/state`
      ? handleState(admin, request) : handleAction(admin, request)),
  })

  return () => {
    disposeList()
    disposeActions()
  }
}
