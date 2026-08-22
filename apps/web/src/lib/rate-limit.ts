/**
 * Request limits, kept in one table rather than scattered across route files.
 *
 * The whole policy is visible here on purpose: a limit that is too tight is
 * indistinguishable from an outage for the streamer it hits, and one that is
 * too loose is not a limit. Both failure modes are easier to reason about when
 * the numbers sit next to each other.
 */

import type { FastifyRequest } from 'fastify'
import type { WebContext } from '../context.js'
import { readSession, SESSION_COOKIE } from '../plugins/session.js'

/** Requests per minute. */
const LIMITS = {
  /**
   * A signed-in dashboard is chatty in bursts — opening a session page fires a
   * detail fetch, a settings fetch and a catalog search, and the streamer may
   * be collecting bonuses one click per second during a hunt.
   */
  authenticated: 600,

  /**
   * Anonymous traffic. Enough for the login page and a few misses, not enough
   * to enumerate session ids or grind at the overlay token space.
   */
  anonymous: 120,

  /**
   * Starting an OAuth flow costs a state entry, and the callback exchanges a
   * code against Kick. Both are cheap to spam and expensive to serve.
   */
  auth: 20,

  /**
   * A socket upgrade. Normal use is one dashboard plus one OBS source; our own
   * client backs off to a 10s ceiling, so even a reconnect storm after a deploy
   * stays well under this.
   */
  socket: 60,
} as const

/**
 * Paths that are never rate limited, and why each one has to be.
 *
 * `/webhooks/kick` — every chat message on every live channel arrives here, all
 * of it from Kick's own egress addresses. Any IP-keyed limit would either
 * throttle a busy channel's chat or be too high to mean anything. What actually
 * protects this endpoint is the RSA signature check (§12), the 1MB body limit,
 * and the unique index on (session_id, kick_message_id) that absorbs
 * redeliveries. Unsigned junk still costs a signature verification, which is
 * the accepted residual risk — it is sub-millisecond, and the platform edge
 * sits in front of it.
 *
 * Static assets — a dashboard page pulls ten of them, they are served from
 * memory with a cache header, and counting them would spend a Redis round trip
 * per file to protect nothing.
 */
function isExempt(url: string): boolean {
  if (url.startsWith('/webhooks/')) return true
  return !url.startsWith('/api/') && !url.startsWith('/auth/') && !url.startsWith('/ws/')
}

/**
 * Which budget a request draws from.
 *
 * These have to be separate counters, not one counter with a varying ceiling:
 * a shared bucket means a burst of ordinary API calls exhausts the count, and
 * the next OAuth request is compared against *its* much lower ceiling and
 * refused on the spot. Each class gets its own key.
 */
type Budget = 'auth' | 'socket' | 'api'

function budgetFor(url: string): Budget {
  if (url.startsWith('/auth/')) return 'auth'
  if (url.startsWith('/ws/')) return 'socket'
  return 'api'
}

export function rateLimitOptions(ctx: WebContext) {
  return {
    global: true,
    // Redis so counters hold across web instances (§8) — a per-process limiter
    // multiplies its own ceiling by the replica count. Under test there is only
    // ever one process, so the plugin's in-memory store is exactly equivalent
    // and `npm test` stays infrastructure-free.
    //
    // Note the dedicated connection: it fails fast rather than queueing, which
    // is what makes the `skipOnError` below actually reachable.
    ...(ctx.env.NODE_ENV === 'test' ? {} : { redis: ctx.rateLimitRedis }),

    /**
     * If the store is unreachable, let the request through.
     *
     * A rate limiter is a safety belt, not an authorization gate — nothing here
     * decides who may do what, only how often. When Redis is down the choice is
     * between serving everyone and serving no one, and taking the dashboard
     * offline to protect it from load it isn't currently under is the worse of
     * the two.
     */
    skipOnError: true,
    // Distinct from the app's own keys, and short: this prefix is written on
    // every request.
    nameSpace: 'rl:',
    timeWindow: '1 minute',
    // Without this a client that keeps hammering while limited never serves out
    // its window, which turns a burst into a much longer outage than intended.
    continueExceeding: false,

    max: (req: FastifyRequest) => {
      switch (budgetFor(req.url)) {
        case 'auth':
          return LIMITS.auth
        case 'socket':
          return LIMITS.socket
        default:
          return signedInUserId(ctx, req) ? LIMITS.authenticated : LIMITS.anonymous
      }
    },

    /**
     * Signed-in requests are counted per user, not per IP. Streamers behind a
     * shared address — a university, a mobile carrier, one household with two
     * accounts — would otherwise spend each other's budget.
     */
    keyGenerator: (req: FastifyRequest) => {
      const userId = signedInUserId(ctx, req)
      const who = userId ? `u:${userId}` : `ip:${req.ip}`
      return `${budgetFor(req.url)}:${who}`
    },

    allowList: (req: FastifyRequest) => isExempt(req.url),

    // Shaped so the error handler can recognise it and re-emit it in the same
    // envelope as every other error, which is what the client parses.
    errorResponseBuilder: (_req: FastifyRequest, context: { after: string }) => ({
      statusCode: 429,
      code: 'rate_limited',
      error: 'Too Many Requests',
      message: `Too many requests — try again in ${context.after}.`,
    }),
  }
}

/**
 * Both `max` and `keyGenerator` need the caller's identity, and the plugin
 * calls them separately. Cached per request so the cookie's HMAC is verified
 * once rather than twice on every single request.
 */
const CACHE = Symbol('rateLimitUserId')

function signedInUserId(ctx: WebContext, req: FastifyRequest): string | null {
  const holder = req as FastifyRequest & { [CACHE]?: string | null }
  if (CACHE in holder) return holder[CACHE] ?? null

  const cookie = req.cookies?.[SESSION_COOKIE]
  const userId = readSession(ctx.env.SESSION_SECRET, cookie)?.userId ?? null
  holder[CACHE] = userId
  return userId
}
