/**
 * The server's error contract, pinned against a plugin-ordering hazard that
 * broke it silently once already.
 *
 * `@fastify/websocket` replaces every route handler with a wrapper of its own,
 * and that wrapper binds whatever error handler was in scope when the route was
 * registered. Register `setErrorHandler` after the routes — the natural reading
 * order, and how server.ts was originally written — and it never runs: every
 * UnauthorizedError comes back as a Fastify default 500 instead of a 401, and
 * the dashboard reports "Something went wrong" rather than sending an expired
 * session to the login page.
 *
 * Built with a stub context because none of the route registrars touch a
 * datastore at registration time; the routes exercised here fail before they
 * would.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
// From dist, not src: server.ts uses NodeNext `.js` specifiers, which Node's
// type stripping resolves literally. The rest of the suite already needs a
// build for its cross-package imports.
import { buildServer } from '../dist/server.js'
import type { WebContext } from '../dist/context.js'

const silent = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return silent },
  level: 'silent',
}

const ctx = {
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'a-test-secret-long-enough',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    CORS_ORIGINS: [],
    ADMIN_KICK_USER_IDS: [],
  },
  log: silent,
  redis: { async ping() { return 'PONG' } },
  registry: { ids: () => [], all: () => [], get: () => null, require: () => null },
} as unknown as WebContext

const server = await buildServer(ctx)
test.after(() => server.close())

test('an unauthenticated API call is a 401, not a 500', async () => {
  const res = await server.inject({ method: 'GET', url: '/api/me' })

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), {
    error: { code: 'unauthorized', message: 'Not signed in' },
  })
})

test('every authenticated route agrees — the wrapper is applied to all of them', async () => {
  for (const url of ['/api/me', '/api/sessions/whatever', '/api/games/bonus-hunt/config']) {
    const res = await server.inject({ method: 'GET', url })
    assert.equal(res.statusCode, 401, `${url} should be 401, got ${res.statusCode}`)
    assert.equal(res.json().error.code, 'unauthorized', url)
  }
})

test('an unknown route uses the same error envelope', async () => {
  const res = await server.inject({ method: 'GET', url: '/api/nope' })

  assert.equal(res.statusCode, 404)
  assert.equal(res.json().error.code, 'not_found')
})

test('health and readiness answer without a session', async () => {
  assert.equal((await server.inject('/healthz')).statusCode, 200)
  assert.equal((await server.inject('/readyz')).statusCode, 200)
})

test('a foreign origin gets no Access-Control-Allow-Origin', async () => {
  const res = await server.inject({
    method: 'GET',
    url: '/api/me',
    headers: { origin: 'https://evil.example.com' },
  })

  assert.equal(res.headers['access-control-allow-origin'], undefined)
})

// ─── rate limiting ──────────────────────────────────────────────────────────
//
// Uses the plugin's in-memory store (NODE_ENV=test), so these are the real
// counts the production policy applies — only the backing store differs.
//
// Each test claims its own client address. The server runs with trustProxy, so
// X-Forwarded-For decides `req.ip` and therefore the bucket; without this the
// tests would share a counter and their results would depend on file order.

const from = (ip: string) => ({ 'x-forwarded-for': ip })

/** Fires up to `n` requests, returning the 1-based index of the first 429. */
async function firstRefusal(url: string, n: number, ip: string) {
  for (let i = 1; i <= n; i++) {
    const res = await server.inject({ method: 'GET', url, headers: from(ip) })
    if (res.statusCode === 429) return i
  }
  return null
}

test('anonymous API traffic is capped, and says how long to wait', async () => {
  assert.equal(await firstRefusal('/api/me', 130, '10.0.0.1'), 121, 'limit is 120/min')

  const res = await server.inject({ method: 'GET', url: '/api/me', headers: from('10.0.0.1') })
  assert.equal(res.statusCode, 429)
  assert.equal(res.json().error.code, 'rate_limited')
  assert.match(res.json().error.message, /try again in/)
  // Without this the client has nothing to back off against.
  assert.equal(String(res.headers['retry-after']), '60')
})

test('the OAuth budget is tighter, and separate from the API one', async () => {
  const ip = '10.0.0.2'
  assert.equal(await firstRefusal('/auth/kick', 30, ip), 21, 'auth limit is 20/min')

  // Same client, different budget: the API allowance is untouched. Sharing one
  // counter across both is the bug this separation exists to prevent — a burst
  // of ordinary API calls would leave the next login refused on the spot.
  const res = await server.inject({ method: 'GET', url: '/api/me', headers: from(ip) })
  assert.notEqual(res.statusCode, 429)
})

test('exhausting the API budget leaves logins working', async () => {
  const ip = '10.0.0.3'
  await firstRefusal('/api/me', 130, ip)

  const res = await server.inject({ method: 'GET', url: '/auth/kick', headers: from(ip) })
  assert.notEqual(res.statusCode, 429)
})

test('the webhook endpoint is never throttled', async () => {
  // Kick delivers every chat message on every live channel from its own egress
  // addresses, so an IP-keyed limit would throttle a busy channel's chat. The
  // signature check and the dedupe index are what protect this route.
  for (let i = 1; i <= 200; i++) {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/kick',
      headers: { ...from('10.0.0.4'), 'content-type': 'application/json' },
      payload: {},
    })
    assert.notEqual(res.statusCode, 429, `throttled at delivery ${i}`)
  }
})

test('static assets and pages are not counted', async () => {
  const ip = '10.0.0.5'
  await firstRefusal('/api/me', 130, ip)

  for (const url of ['/login', '/app.js']) {
    const res = await server.inject({ method: 'GET', url, headers: from(ip) })
    assert.notEqual(res.statusCode, 429, url)
  }
})
