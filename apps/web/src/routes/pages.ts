/**
 * Serves the dashboard and overlay.
 *
 * The front-end is plain HTML plus ES modules served from the API origin, which
 * keeps the session cookie same-origin and avoids a second build pipeline that
 * could drift from the backend. Pretty URLs map to files so the pages can link
 * to `/session?id=…` rather than `/session.html?id=…`.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import type { WebContext } from '../context.js'
import { readSession, SESSION_COOKIE } from '../plugins/session.js'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public')

/** Pretty path -> file. Everything else 404s as an API route. */
const PAGES: Record<string, string> = {
  '/login': 'login.html',
  '/games': 'games.html',
  '/setup': 'setup.html',
  '/session': 'session.html',
  '/history': 'history.html',
  // A finished session, read-only. Distinct from /session, which is a live
  // control surface and must not be pointed at a result already announced.
  '/recap': 'recap.html',
  '/settings': 'settings.html',
}

export async function registerPageRoutes(app: FastifyInstance, ctx: WebContext) {
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    // Pretty URLs are handled below; serving index.html implicitly would make
    // "/" ambiguous between the app shell and a 404.
    index: false,
    cacheControl: ctx.env.NODE_ENV === 'production',
    maxAge: ctx.env.NODE_ENV === 'production' ? '5m' : 0,
  })

  for (const [path, file] of Object.entries(PAGES)) {
    app.get(path, (_req, reply) => reply.sendFile(file))
  }

  /**
   * The operator panel (§7). Gated here as well as on every /api/admin route,
   * because a streamer who follows the link out of curiosity should land back
   * on their own dashboard rather than on a shell of empty tables reporting
   * four hundred and three.
   *
   * A redirect, not a 403: this is a page, and the JSON error handler that
   * serves the API would render as a blank screen with a code on it.
   */
  app.get('/admin', async (req, reply) => {
    const payload = readSession(ctx.env.SESSION_SECRET, req.cookies[SESSION_COOKIE])
    if (!payload) return reply.redirect('/login')

    const user = await ctx.repos.users.byId(payload.userId)
    if (!user || !ctx.env.ADMIN_KICK_USER_IDS.includes(user.kickUserId)) {
      return reply.redirect('/games')
    }
    return reply.sendFile('admin.html')
  })

  /**
   * The OBS browser source. The token is read by the page from its own path, so
   * it never appears in a query string that might end up in a log or a
   * screen-share of the address bar.
   */
  app.get('/overlay/:token', (_req, reply) => reply.sendFile('overlay.html'))

  /**
   * The giveaway verification page — Giveaways §3.
   *
   * Public and unauthenticated, and that is the entire point: a page only the
   * streamer can open proves nothing to the chat that is accusing them. It sits
   * here rather than in `PAGES` because everything in that map is a dashboard
   * screen behind a session, and this is the one page in the product deliberately
   * meant to be pasted into somebody else's chat.
   *
   * Everything behind it was designed to be published — the seed is only served
   * once the session has ended, and `routes/verify.ts` refuses it before then.
   */
  app.get('/verify/:sessionId', (_req, reply) => reply.sendFile('verify.html'))

  /** Signed in goes to the catalog; everyone else to the login screen. */
  app.get('/', (req, reply) => {
    const signedIn = readSession(ctx.env.SESSION_SECRET, req.cookies[SESSION_COOKIE]) !== null
    return reply.redirect(signedIn ? '/games' : '/login')
  })
}
