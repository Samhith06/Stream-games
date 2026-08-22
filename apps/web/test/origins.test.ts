/**
 * Cross-origin policy. Both halves matter for different reasons: `corsOrigin`
 * governs what a browser may read back over HTTP, `isAllowedSocketOrigin`
 * governs who may open a cookie-authenticated WebSocket — which CORS does not
 * cover at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { Env } from '@streamarena/platform'
import { corsOrigin, isAllowedSocketOrigin } from '../src/lib/origins.ts'

const env = (overrides: Partial<Env> = {}) =>
  ({
    PUBLIC_BASE_URL: 'https://streamarena.gg',
    CORS_ORIGINS: [],
    ...overrides,
  }) as Env

test('cross-origin is denied unless an allowlist is configured', () => {
  assert.equal(corsOrigin(env()), false)
})

test('a configured allowlist is passed through verbatim', () => {
  assert.deepEqual(corsOrigin(env({ CORS_ORIGINS: ['https://app.example.com'] })), [
    'https://app.example.com',
  ])
})

test('a socket from the page we just served is allowed', () => {
  // The request arrived on this host, so a page reporting it really is ours.
  assert.equal(isAllowedSocketOrigin(env(), 'https://streamarena.gg', 'streamarena.gg'), true)
})

test('a second hostname for the same deployment still works', () => {
  // Development behind a Cloudflare tunnel: PUBLIC_BASE_URL is the tunnel, the
  // browser is on localhost, and both are genuinely us.
  const e = env({ PUBLIC_BASE_URL: 'https://tunnel.trycloudflare.com' })
  assert.equal(isAllowedSocketOrigin(e, 'http://localhost:3000', 'localhost:3000'), true)
  assert.equal(isAllowedSocketOrigin(e, 'https://tunnel.trycloudflare.com', 'localhost:3000'), true)
})

test('scheme is not compared, because TLS terminates at the proxy', () => {
  assert.equal(isAllowedSocketOrigin(env(), 'https://streamarena.gg', 'streamarena.gg'), true)
  assert.equal(isAllowedSocketOrigin(env(), 'http://streamarena.gg', 'streamarena.gg'), true)
})

test('a socket from anywhere else is rejected', () => {
  const host = 'streamarena.gg'
  // The cross-site WebSocket hijacking case: an attacker's page opening a
  // socket in the streamer's browser, riding their cookie.
  assert.equal(isAllowedSocketOrigin(env(), 'https://evil.example.com', host), false)
  // A lookalike host must not pass on a prefix or suffix match.
  assert.equal(isAllowedSocketOrigin(env(), 'https://streamarena.gg.evil.com', host), false)
  assert.equal(isAllowedSocketOrigin(env(), 'https://notstreamarena.gg', host), false)
  // Same hostname, different port is a different origin.
  assert.equal(isAllowedSocketOrigin(env(), 'https://streamarena.gg:8443', host), false)
  // "null" is what a sandboxed iframe reports; it is not a host we serve.
  assert.equal(isAllowedSocketOrigin(env(), 'null', host), false)
})

test('an allowlisted frontend may open a socket', () => {
  const e = env({ CORS_ORIGINS: ['https://app.example.com'] })
  assert.equal(isAllowedSocketOrigin(e, 'https://app.example.com', 'api.example.com'), true)
  assert.equal(isAllowedSocketOrigin(e, 'https://other.example.com', 'api.example.com'), false)
  // The allowlist is matched on full origin, so scheme counts there.
  assert.equal(isAllowedSocketOrigin(e, 'http://app.example.com', 'api.example.com'), false)
})

test('a missing Origin is allowed — non-browser clients send none', () => {
  // Browsers always send one, so this does not weaken the guard; it keeps the
  // smoke tests and any server-side client working.
  assert.equal(isAllowedSocketOrigin(env(), undefined, 'streamarena.gg'), true)
})

test('a malformed configured origin never accidentally matches', () => {
  const e = env({ PUBLIC_BASE_URL: 'not a url', CORS_ORIGINS: ['also not a url'] })
  assert.equal(isAllowedSocketOrigin(e, 'https://evil.example.com', 'streamarena.gg'), false)
})
