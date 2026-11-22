/** The panel's HTTP surface: routes, guards, and the actions behind them. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTION_HEADER, ACTION_PREFIX, ROUTE_PREFIX, handleAction, isLoopbackPeer, registerRoutes } from '../lib/http.js'

/** Capture registered routes instead of binding a socket. */
function fakeCtx() {
  const routes = new Map()
  return {
    routes,
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
}

const admin = {
  calls: [],
  async inventory() {
    return [{ route: 'fake', displayName: 'Fake Agent', capabilities: ['list'], sessions: [{ sessionId: 's1' }] }]
  },
  async close(route, sessionId) {
    this.calls.push(['close', route, sessionId])
    return { route, sessionId, closed: true }
  },
  async delete(route, sessionId) {
    this.calls.push(['delete', route, sessionId])
    return { route, sessionId, deleted: true }
  },
}

const ORIGIN = 'http://127.0.0.1:1234'

/** Drive a registered raw handler the way the server does, capturing its answer. */
async function serveRoute(ctx, path, request, remoteAddress = '127.0.0.1') {
  const route = ctx.routes.get(path)
  const chunks = []
  const req = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (request.body === null) return
      const reader = request.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield Buffer.from(value)
      }
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(body) { chunks.push(Buffer.from(body)) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }
}

function get() {
  return new Request(`${ORIGIN}${ROUTE_PREFIX}`, { headers: { accept: 'application/json' } })
}

/** A mutation request in the shape the harness actually delivers: GET + query. */
function act(path, query = {}, headers = {}) {
  const search = new URLSearchParams(query).toString()
  return new Request(`${ORIGIN}${ACTION_PREFIX}/${path}?${search}`, { headers })
}

/** A POST, which the server refuses to plugins; the handler still tolerates it. */
function post(path, body, headers = {}) {
  return new Request(`${ORIGIN}${ACTION_PREFIX}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('registers two raw handlers: the read needs the peer address too', () => {
  const ctx = fakeCtx()
  const dispose = registerRoutes(ctx, admin)
  assert.deepEqual([...ctx.routes.keys()].sort(), [ROUTE_PREFIX, ACTION_PREFIX])
  const read = ctx.routes.get(ROUTE_PREFIX)
  const write = ctx.routes.get(ACTION_PREFIX)
  assert.equal(read.kind, 'exact')
  assert.equal(typeof read.handler, 'function', 'the read owns the raw request, to see the peer address')
  assert.equal(write.kind, 'prefix')
  assert.equal(ACTION_PREFIX.endsWith('/'), false, 'a prefix path must not carry a trailing slash')
  assert.equal(typeof write.handler, 'function')
  dispose()
  assert.equal(ctx.routes.size, 0)
})

test('the inventory route answers JSON to a loopback peer', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const response = await serveRoute(ctx, ROUTE_PREFIX, get(), '127.0.0.1')
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(JSON.parse(response.body).routes[0].route, 'fake')
})

test('a non-loopback peer is refused before any handler runs', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const response = await serveRoute(ctx, ROUTE_PREFIX, get(), '10.0.0.7')
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.body).error.code, 'PEER')
  assert.deepEqual(admin.calls, [], 'nothing ran for a remote caller')
})

test('loopback detection covers the shapes a socket reports', () => {
  assert.equal(isLoopbackPeer('127.0.0.1'), true)
  assert.equal(isLoopbackPeer('::1'), true)
  assert.equal(isLoopbackPeer('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackPeer('127.0.0.5'), true)
  assert.equal(isLoopbackPeer('10.0.0.7'), false)
  assert.equal(isLoopbackPeer('::ffff:10.0.0.7'), false)
  assert.equal(isLoopbackPeer(undefined), false)
})

test('a mutation without the action header is refused', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const action = (request) => handleAction(admin, request)
  const response = await action(act('close', { route: 'fake', sessionId: 's1' }))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'ACTION_HEADER')
  assert.deepEqual(admin.calls, [], 'nothing ran')
})

test('a cross-origin mutation is refused even with the header', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const action = (request) => handleAction(admin, request)
  const response = await action(act('close', { route: 'fake', sessionId: 's1' }, {
    [ACTION_HEADER]: '1',
    origin: 'https://evil.example',
  }))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, 'ORIGIN')
})

test('a same-origin mutation with the header runs', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const action = (request) => handleAction(admin, request)

  const closed = await action(act('close', { route: 'fake', sessionId: 's1' }, {
    [ACTION_HEADER]: '1',
    origin: ORIGIN,
  }))
  assert.equal(closed.status, 200)
  assert.deepEqual(await closed.json(), { route: 'fake', sessionId: 's1', closed: true })

  const deleted = await action(act('delete', { route: 'fake', sessionId: 's2' }, { [ACTION_HEADER]: '1' }))
  assert.equal(deleted.status, 200)
  assert.deepEqual(admin.calls, [['close', 'fake', 's1'], ['delete', 'fake', 's2']])
})

test('fork names a DSH Session and reports the branch', async () => {
  const ctx = fakeCtx()
  const forking = {
    async inventory() { return [] },
    async fork(request) {
      this.seen = request
      return { from: 'ses_a', to: 'ses_b' }
    },
    async routeForSession(id) { return id === 'ds_1' ? 'fake' : undefined },
  }
  registerRoutes(ctx, forking)
  const resource = (request) => handleAction(forking, request)

  const response = await resource(act('fork', { dshSessionId: 'ds_1' }, { [ACTION_HEADER]: '1' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { from: 'ses_a', to: 'ses_b' })
  assert.deepEqual(forking.seen, { route: 'fake', dshSessionId: 'ds_1' },
    'the route is resolved from the binding when the caller omits it')
})

test('fork without a DSH Session is rejected', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const response = await handleAction(admin, act('fork', {}, { [ACTION_HEADER]: '1' }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'ARGS')
})

test('GET on the action prefix is refused, and so is an unknown action', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const action = (request) => handleAction(admin, request)

  // A bare GET without the action header is still refused.
  const read = await action(act('close', { route: 'fake', sessionId: 's1' }))
  assert.equal(read.status, 403)

  const unknown = await action(act('explode', { route: 'fake', sessionId: 's1' }, { [ACTION_HEADER]: '1' }))
  assert.equal(unknown.status, 404)
})

test('missing arguments are rejected before any work', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const action = (request) => handleAction(admin, request)
  const response = await action(act('close', { route: 'fake' }, { [ACTION_HEADER]: '1' }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'ARGS')
})

test('an oversized body is rejected when a client does send one', async () => {
  const ctx = fakeCtx()
  registerRoutes(ctx, admin)
  const action = (request) => handleAction(admin, request)
  // POST is refused by the server in production, but the handler still bounds
  // the body it accepts rather than trusting a caller.
  const response = await action(post('close', { route: 'x'.repeat(9_000), sessionId: 's1' }, { [ACTION_HEADER]: '1' }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'BODY')
})

test('a failing action reports its own code', async () => {
  const ctx = fakeCtx()
  const failing = {
    async inventory() { return [] },
    async close() {
      const error = new Error('cannot fork sessions')
      error.code = 'UNSUPPORTED'
      throw error
    },
  }
  const response = await handleAction(failing, act('close', { route: 'f', sessionId: 's' }, { [ACTION_HEADER]: '1' }))
  assert.equal(response.status, 400)
  assert.deepEqual((await response.json()).error, { code: 'UNSUPPORTED', message: 'cannot fork sessions' })
})
