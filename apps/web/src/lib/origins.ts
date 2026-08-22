/**
 * Who is allowed to talk to this API from a browser.
 *
 * The dashboard, the overlay and the API are all served from one origin, so in
 * the normal deployment *nothing* needs cross-origin access and the answer is
 * "no one". `CORS_ORIGINS` exists as an explicit opt-in for anyone running a
 * separately hosted frontend.
 *
 * The old default reflected whatever `Origin` the caller sent and paired it
 * with `credentials: true`. Today the session cookie is SameSite=Lax, so a
 * cross-site `fetch` wouldn't carry it and the practical exposure was small —
 * but that is one cookie-policy change away from letting any site on the
 * internet read every authenticated endpoint. Denying by default costs nothing
 * here and removes the trapdoor.
 */

import type { Env } from '@streamarena/platform'

/**
 * The value for `@fastify/cors`'s `origin` option.
 *
 * `false` omits `Access-Control-Allow-Origin` entirely, which blocks
 * cross-origin *reads* in the browser. Same-origin requests are unaffected —
 * they are never subject to CORS — so the dashboard keeps working untouched.
 */
export function corsOrigin(env: Env): string[] | false {
  return env.CORS_ORIGINS.length > 0 ? [...env.CORS_ORIGINS] : false
}

/**
 * Whether a WebSocket handshake may proceed.
 *
 * WebSockets are exempt from CORS: the browser performs the upgrade and hands
 * the socket over regardless of what the server says about origins. That makes
 * a cookie-authenticated socket vulnerable to cross-site WebSocket hijacking,
 * and the `Origin` header is the only thing that distinguishes our own page
 * from an attacker's. Checking it is the defence.
 *
 * Same-origin is decided against the request's own `Host`, not against
 * `PUBLIC_BASE_URL`: one deployment is routinely reachable on more than one
 * hostname — a Cloudflare tunnel next to localhost in development, apex beside
 * www in production — and every one of those is genuinely our own page. Host is
 * also the only value that is true per-connection. Scheme is deliberately not
 * compared, because behind TLS termination the proxy speaks http to us while
 * the browser reports https.
 *
 * A missing `Origin` is allowed: non-browser clients (the smoke tests, `wscat`,
 * anything server-side) send none, and they are not the threat this guards
 * against — a browser always sends one.
 */
export function isAllowedSocketOrigin(
  env: Env,
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true

  const from = safeUrl(origin)
  if (!from) return false

  if (host && from.host === host) return true
  if (from.host === safeUrl(env.PUBLIC_BASE_URL)?.host) return true

  return env.CORS_ORIGINS.some((allowed) => safeUrl(allowed)?.origin === from.origin)
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
