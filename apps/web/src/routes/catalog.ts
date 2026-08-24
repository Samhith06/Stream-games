/**
 * Slot catalog routes — §21.
 *
 * The unresolved queue is "the most valuable component in the dashboard"
 * (§20), and these are the calls behind it: search, confirm, and the
 * never-block escape hatch that turns free text into a usable slot.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { WebContext } from '../context.js'
import { requireOwnedSession, requireUser } from '../plugins/session.js'

export async function registerCatalogRoutes(app: FastifyInstance, ctx: WebContext) {
  /** The slot picker. */
  app.get('/api/catalog/slots', async (req) => {
    await requireUser(ctx, req)
    const query = req.query as { q?: string; limit?: string }
    const slots = await ctx.catalog.search(query.q ?? '', Number(query.limit ?? 25))
    return { slots }
  })

  /**
   * §21 — "Never block on the catalog. The slot picker's empty state offers
   * 'Add as custom slot' accepting free text, so a missing catalog entry can
   * never stop a hunt or a tournament mid-stream."
   */
  app.post('/api/catalog/slots/custom', async (req) => {
    await requireUser(ctx, req)
    const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body)
    const slot = await ctx.catalog.createCustom(body.name)
    return { slot }
  })

  /**
   * Resolving an unresolved entry. Two things happen: the session learns which
   * slot it was, and the catalog learns the alias — that second half is the
   * flywheel that makes matching improve without anyone curating a dictionary.
   */
  app.post('/api/sessions/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { user } = await requireOwnedSession(ctx, req, id)

    const body = z
      .object({
        /** Bonus Hunt uses an entry id; the tournament keys its pool by userId. */
        entryId: z.string().min(1),
        slotId: z.string().uuid().optional(),
        /** Free text, when the streamer typed a name instead of picking one. */
        customName: z.string().min(1).max(120).optional(),
        /** What the viewer originally typed, so the alias learned is the right one. */
        rawText: z.string().max(200).optional(),
        action: z.enum(['resolve', 'discard']).default('resolve'),
      })
      .parse(req.body)

    const session = await ctx.repos.sessions.byId(id)
    /*
     * Bonus Hunt keys its queue by entry id; the games built on a viewer pool —
     * Tournament and Slot Bingo — key theirs by user id and name their actions
     * accordingly. The endpoint sends both ids in the payload either way, so
     * only the action name has to know the difference.
     */
    const pooled =
      session?.gameId === 'slot-tournament' ||
      session?.gameId === 'slot-bingo' ||
      session?.gameId === 'team-battles'

    if (body.action === 'discard') {
      await ctx.queues.ingest.add('control', {
        kind: 'control',
        sessionId: id,
        action: pooled ? 'pool.remove' : 'entry.remove',
        payload: { entryId: body.entryId, userId: body.entryId },
        actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
        at: Date.now(),
      })
      return reply.send({ ok: true })
    }

    let slot = body.slotId ? await ctx.catalog.byId(body.slotId) : null
    if (!slot && body.customName) slot = await ctx.catalog.createCustom(body.customName)
    if (!slot) {
      return reply.code(400).send({
        error: { code: 'no_slot', message: 'Pick a slot or supply a custom name.' },
      })
    }

    // §21 — the alias flywheel. Every human decision here raises the auto-match
    // rate for every channel, which is why we bother capturing rawText.
    if (body.rawText) await ctx.catalog.confirm(body.rawText, slot.slotId)

    await ctx.queues.ingest.add('control', {
      kind: 'control',
      sessionId: id,
      action: pooled ? 'pool.resolve' : 'entry.resolve',
      payload: {
        entryId: body.entryId,
        userId: body.entryId,
        slotId: slot.slotId,
        slotName: slot.name,
        provider: slot.provider,
        thumbnail: slot.thumbnail ?? null,
      },
      actor: { userId: user.id, username: user.displayName, role: 'broadcaster' },
      at: Date.now(),
    })

    return reply.send({ ok: true, slot })
  })
}
