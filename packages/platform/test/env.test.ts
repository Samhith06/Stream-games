/**
 * The production guards in loadEnv.
 *
 * Every case here is a value that boots fine in development and is silently
 * wrong once deployed, which is exactly the class of bug that is cheapest to
 * catch at startup and most expensive to catch in the wild.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadEnv } from '../src/env.ts'

/** A complete, valid production environment. Each test spoils one field. */
const PRODUCTION: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://streamarena.gg',
  DATABASE_URL: 'postgres://user:pw@db.internal:5432/streamarena',
  REDIS_URL: 'redis://cache.internal:6379',
  TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
  SESSION_SECRET: 'a-genuinely-random-session-secret',
}

const withEnv = (overrides: NodeJS.ProcessEnv) => ({ ...PRODUCTION, ...overrides })

const rejects = (overrides: NodeJS.ProcessEnv, expected: RegExp) =>
  assert.throws(() => loadEnv(withEnv(overrides)), expected)

test('a complete production environment loads', () => {
  const env = loadEnv(PRODUCTION)
  assert.equal(env.NODE_ENV, 'production')
  assert.deepEqual(env.CORS_ORIGINS, [])
})

test('development is left alone — localhost and placeholders are the point', () => {
  const env = loadEnv({
    ...PRODUCTION,
    NODE_ENV: 'development',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    SESSION_SECRET: 'change-me-to-a-long-random-string',
    TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
  })
  assert.equal(env.PUBLIC_BASE_URL, 'http://localhost:3000')
})

test('WEB_PORT falls back to the platform-injected PORT', () => {
  assert.equal(loadEnv({ ...PRODUCTION, PORT: '8080' }).WEB_PORT, 8080)
  // An explicit WEB_PORT still wins, so a self-hosted deploy keeps control.
  assert.equal(loadEnv({ ...PRODUCTION, PORT: '8080', WEB_PORT: '4000' }).WEB_PORT, 4000)
  assert.equal(loadEnv(PRODUCTION).WEB_PORT, 3000)
})

test('production refuses the placeholder secrets from .env.example', () => {
  rejects({ TOKEN_ENCRYPTION_KEY: '0'.repeat(64) }, /all-zero placeholder/)
  rejects({ SESSION_SECRET: 'change-me-to-a-long-random-string' }, /placeholder/)
})

test('production refuses a base URL that would break OAuth and overlay links', () => {
  rejects({ PUBLIC_BASE_URL: 'http://streamarena.gg' }, /must be https/)
  rejects({ PUBLIC_BASE_URL: 'https://localhost:3000' }, /localhost/)
})

test('production refuses an unsigned webhook endpoint', () => {
  rejects({ KICK_WEBHOOK_ALLOW_UNSIGNED: 'true' }, /must be false in production/)
})

test('a wildcard CORS origin is rejected rather than quietly matching nothing', () => {
  rejects({ CORS_ORIGINS: '*' }, /may not contain/)
})

test('CORS origins must be bare origins', () => {
  rejects({ CORS_ORIGINS: 'https://app.example.com/dashboard' }, /no path/)
  rejects({ CORS_ORIGINS: 'app.example.com' }, /not a valid URL/)

  const env = loadEnv(withEnv({ CORS_ORIGINS: 'https://a.example.com, https://b.example.com' }))
  assert.deepEqual(env.CORS_ORIGINS, ['https://a.example.com', 'https://b.example.com'])
})

test('every problem is reported at once, not one deploy at a time', () => {
  assert.throws(
    () =>
      loadEnv(
        withEnv({
          SESSION_SECRET: 'change-me-to-a-long-random-string',
          PUBLIC_BASE_URL: 'http://localhost:3000',
        }),
      ),
    (err: Error) => {
      assert.match(err.message, /placeholder/)
      assert.match(err.message, /must be https/)
      assert.match(err.message, /localhost/)
      return true
    },
  )
})
