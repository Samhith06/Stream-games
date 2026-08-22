import { createRequire } from 'node:module'
import { pino, type Logger } from 'pino'

export type { Logger }

/**
 * Pretty output is a development nicety supplied by an optional dependency.
 * If it isn't installed, fall back to JSON rather than refusing to boot — a
 * missing dev formatter must never be the reason production won't start.
 */
function prettyTransport(): object | undefined {
  try {
    createRequire(import.meta.url).resolve('pino-pretty')
    return { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
  } catch {
    return undefined
  }
}

export function createLogger(opts: { level: string; name: string; pretty?: boolean }): Logger {
  return pino({
    name: opts.name,
    level: opts.level,
    // Tokens and chat content must never reach the log. A leaked refresh token
    // is a password (§12), and dumping viewer messages turns our logs into a
    // chat archive nobody consented to.
    redact: {
      paths: [
        'accessToken',
        'refreshToken',
        'access_token',
        'refresh_token',
        'req.headers.authorization',
        'req.headers.cookie',
        '*.accessToken',
        '*.refreshToken',
      ],
      censor: '[redacted]',
    },
    ...(opts.pretty ? (prettyTransport() ?? {}) : {}),
  })
}
