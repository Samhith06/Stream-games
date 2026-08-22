import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { ZodError } from 'zod'
import type { WebContext } from './context.js'
import { registerWebhookRoutes } from './routes/webhooks.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerSessionRoutes } from './routes/sessions.js'
import { registerCatalogRoutes } from './routes/catalog.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerWebSocketRoutes } from './routes/ws.js'
import { registerDetailRoutes } from './routes/detail.js'
import { registerPageRoutes } from './routes/pages.js'
import { ForbiddenError, NotFoundError, UnauthorizedError } from './plugins/session.js'
import { corsOrigin } from './lib/origins.js'
import { rateLimitOptions } from './lib/rate-limit.js'

export async function buildServer(ctx: WebContext): Promise<FastifyInstance> {
  // Passing a concrete pino instance narrows Fastify's logger generic, which
  // then refuses to match the plain `FastifyInstance` the route registrars take.
  // The cast keeps one logger across both processes without threading that
  // generic through every route module.
  const app = Fastify({
    loggerInstance: ctx.log,
    trustProxy: true,
    // Webhook payloads are small; a generous body limit here would only widen
    // the surface on an endpoint that faces the internet unauthenticated.
    bodyLimit: 1_048_576,
    disableRequestLogging: ctx.env.NODE_ENV === 'production',
  }) as unknown as FastifyInstance

  await app.register(cookie)
  // Denies cross-origin by default — see lib/origins.ts. The dashboard and the
  // overlay are same-origin with the API, so this is a no-op for them.
  await app.register(cors, {
    origin: corsOrigin(ctx.env),
    credentials: true,
    maxAge: 86_400,
  })
  await app.register(websocket, {
    options: { maxPayload: 1_048_576 },
  })

  // After @fastify/cookie, because the limiter keys signed-in traffic by user
  // id rather than by IP. Policy and reasoning live in lib/rate-limit.ts.
  await app.register(rateLimit, rateLimitOptions(ctx))

  /**
   * Kick signs the raw bytes (§12), so the JSON parser has to hand them back
   * untouched — re-serialising a parsed object changes them and every signature
   * check fails.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      ;(req as { rawBody?: Buffer }).rawBody = body
      if (body.length === 0) return done(null, undefined)
      try {
        done(null, JSON.parse(body.toString('utf8')))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  app.get('/healthz', async () => ({ ok: true, service: 'web' }))
  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.redis.ping()
      return { ok: true }
    } catch (err) {
      return reply.code(503).send({ ok: false, error: String(err) })
    }
  })

  /**
   * Registered BEFORE the routes, and that ordering is load-bearing.
   *
   * `@fastify/websocket` replaces every route's handler with a wrapper of its
   * own (it has to, so a plain HTTP request to a socket route can be closed
   * cleanly). The wrapper binds the error handler that was in scope when the
   * route was registered, so a `setErrorHandler` call that comes afterwards
   * never runs — every UnauthorizedError below would surface as a Fastify
   * default 500 instead of a 401, and the dashboard would show "Something went
   * wrong" rather than bouncing an expired session to the login page.
   */
  app.setErrorHandler((raw, req, reply) => {
    const err = raw as Error & { statusCode?: number }

    if (err instanceof UnauthorizedError) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: err.message } })
    }
    if (err instanceof ForbiddenError) {
      return reply.code(403).send({ error: { code: 'forbidden', message: err.message } })
    }
    if (err instanceof NotFoundError) {
      return reply.code(404).send({ error: { code: 'not_found', message: err.message } })
    }
    // @fastify/rate-limit throws the object its errorResponseBuilder returns.
    // Without this it lands in the generic branch below and a throttled client
    // is told "Something went wrong" instead of how long to wait.
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: err.message } })
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'Invalid request body', details: err.issues },
      })
    }

    ctx.log.error({ err: err.message, url: req.url, stack: err.stack }, 'unhandled request error')
    return reply
      .code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500)
      .send({ error: { code: 'internal', message: 'Something went wrong' } })
  })

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'No such route' } }),
  )

  await registerWebhookRoutes(app, ctx)
  await registerAuthRoutes(app, ctx)
  await registerSessionRoutes(app, ctx)
  await registerDetailRoutes(app, ctx)
  await registerCatalogRoutes(app, ctx)
  await registerSettingsRoutes(app, ctx)
  await registerAdminRoutes(app, ctx)
  await registerWebSocketRoutes(app, ctx)
  // Last, so the static handler never shadows an API route.
  await registerPageRoutes(app, ctx)

  return app
}
