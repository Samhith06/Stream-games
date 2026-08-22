/**
 * Typed, validated configuration.
 *
 * Read once at boot and fail loudly. A platform that starts with a missing
 * TOKEN_ENCRYPTION_KEY and only discovers it when the first streamer connects
 * has turned a config error into an outage.
 */

import { z } from 'zod'

const bool = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? dflt : v === 'true' || v === '1'))

const int = (dflt: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int())

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WEB_PORT: int(3000),
  /** The worker's health endpoint. Distinct from WEB_PORT so both can run on one box. */
  WORKER_PORT: int(3001),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  ADMIN_KICK_USER_IDS: csv,

  KICK_CLIENT_ID: z.string().default(''),
  KICK_CLIENT_SECRET: z.string().default(''),
  KICK_REDIRECT_URI: z.string().default('http://localhost:3000/auth/kick/callback'),
  KICK_API_BASE: z.string().url().default('https://api.kick.com'),
  KICK_ID_BASE: z.string().url().default('https://id.kick.com'),
  KICK_WEBHOOK_PUBLIC_KEY: z.string().default(''),
  KICK_WEBHOOK_ALLOW_UNSIGNED: bool(false),

  CHAT_TOKENS_PER_SEC: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 1 : Number(v)))
    .pipe(z.number().positive()),
  CHAT_BATCH_WINDOW_MS: int(7_000),
  DEFAULT_STREAM_DELAY_MS: int(12_000),
  SNAPSHOT_EVERY_N_EVENTS: int(50),
  CORS_ORIGINS: csv,

  /** §21 ship order — exact and near-exact only until there's real data. */
  CATALOG_FUZZY: bool(false),
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Railway, Render, Fly and Heroku all inject PORT and route to whatever the
  // process binds. WEB_PORT stays the explicit knob — it just falls back to
  // PORT, so a platform deploy needs no extra configuration and a health check
  // doesn't quietly probe the wrong port.
  const parsed = envSchema.safeParse({
    ...source,
    WEB_PORT: source.WEB_PORT || source.PORT,
    WORKER_PORT: source.WORKER_PORT || source.PORT,
  })
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`)
  }

  const env = parsed.data
  if (env.NODE_ENV === 'production') assertProductionSafe(env)
  return env
}

/**
 * Checks that only make sense once this is really deployed. Each of these is a
 * value that works fine locally and is silently wrong in production — the kind
 * that surfaces as a broken OAuth redirect or a leaked session weeks later,
 * rather than as an error on the deploy that introduced it.
 */
function assertProductionSafe(env: Env): void {
  const problems: string[] = []

  // An unsigned webhook endpoint is an open command injector for any channel.
  if (env.KICK_WEBHOOK_ALLOW_UNSIGNED) {
    problems.push('KICK_WEBHOOK_ALLOW_UNSIGNED must be false in production')
  }

  // Placeholders straight out of .env.example. The encryption key protects
  // every streamer's Kick tokens at rest; the session secret is the only thing
  // standing between a forged cookie and someone else's dashboard.
  if (/^0+$/.test(env.TOKEN_ENCRYPTION_KEY)) {
    problems.push('TOKEN_ENCRYPTION_KEY is still the all-zero placeholder')
  }
  if (env.SESSION_SECRET.includes('change-me')) {
    problems.push('SESSION_SECRET is still the placeholder from .env.example')
  }

  // PUBLIC_BASE_URL is not cosmetic: OAuth redirects, webhook callbacks and the
  // overlay URL handed to the streamer are all built from it.
  const base = new URL(env.PUBLIC_BASE_URL)
  if (base.protocol !== 'https:') {
    problems.push(`PUBLIC_BASE_URL must be https in production (got ${env.PUBLIC_BASE_URL})`)
  }
  if (base.hostname === 'localhost' || base.hostname === '127.0.0.1') {
    problems.push(`PUBLIC_BASE_URL still points at localhost (${env.PUBLIC_BASE_URL})`)
  }

  // A wildcard here would undo the point of an allowlist. @fastify/cors would
  // happily accept the literal string and match nothing, which is worse than
  // failing: it looks permissive and behaves closed.
  for (const origin of env.CORS_ORIGINS) {
    if (origin === '*') {
      problems.push('CORS_ORIGINS may not contain "*" — list explicit origins or leave it empty')
      continue
    }
    try {
      const url = new URL(origin)
      if (url.origin !== origin) {
        problems.push(`CORS_ORIGINS entry must be a bare origin, no path: ${origin}`)
      }
    } catch {
      problems.push(`CORS_ORIGINS entry is not a valid URL: ${origin}`)
    }
  }

  if (problems.length > 0) {
    const lines = problems.map((p) => `  ${p}`).join('\n')
    throw new Error(`Unsafe production configuration:\n${lines}`)
  }
}
