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
   * The OBS browser source. The token is read by the page from its own path, so
   * it never appears in a query string that might end up in a log or a
   * screen-share of the address bar.
   */
  app.get('/overlay/:token', (_req, reply) => reply.sendFile('overlay.html'))

  /** Signed in goes to the catalog; everyone else to the login screen. */
  app.get('/', (req, reply) => {
    const signedIn = readSession(ctx.env.SESSION_SECRET, req.cookies[SESSION_COOKIE]) !== null
    return reply.redirect(signedIn ? '/games' : '/login')
  })
}
