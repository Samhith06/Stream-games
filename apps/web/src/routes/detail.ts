/**
 * Session detail — the analytics the history detail screen shows on top of the
 * raw projection: worst slot, most requested, and audience participation.
 */

import type { FastifyInstance } from 'fastify'
import type { WebContext } from '../context.js'
import { requireOwnedSession } from '../plugins/session.js'
import { analyseSession } from '../lib/history.js'
import { rebuildProjection } from '../lib/rebuild.js'

export async function registerDetailRoutes(app: FastifyInstance, ctx: WebContext) {
  app.get('/api/sessions/:id/analytics', async (req, reply) => {
    const { id } = req.params as { id: string }
    await requireOwnedSession(ctx, req, id)

    const cached = await ctx.cache.projection(id)
    const state =
      (cached?.state as Record<string, unknown> | undefined) ??
      (await rebuildProjection(ctx, id, 'dashboard'))

    if (!state) {
      // A state-version mismatch. Saying so plainly beats returning zeros that
      // look like a session where nothing happened.
      return reply.code(409).send({
        error: {
          code: 'unreplayable',
          message: 'This session was recorded by an older version of the game and cannot be replayed.',
        },
      })
    }

    return { analytics: analyseSession(state), state }
  })

  /**
   * The event log for one session. This is the "let me replay your session"
   * answer from §11, exposed rather than kept for support tickets only.
   */
  app.get('/api/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string }
    await requireOwnedSession(ctx, req, id)

    const query = req.query as { after?: string; limit?: string }
    const rows = await ctx.repos.events.since(
      id,
      Number(query.after ?? 0),
      Math.min(Number(query.limit ?? 500), 2000),
    )

    return {
      events: rows.map((row) => ({
        seq: Number(row.seq),
        type: row.type,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
      })),
    }
  })
}
