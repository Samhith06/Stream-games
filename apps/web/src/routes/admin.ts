/**
 * The admin panel — §17, §21.
 *
 * "Slot catalog, alias review queue, quota monitoring, channels." This is the
 * platform operator's surface, not the streamer's, and it's gated on an
 * explicit allowlist of Kick user ids rather than any in-app role.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { WebContext } from '../context.js'
import { requireAdmin } from '../plugins/session.js'

export async function registerAdminRoutes(app: FastifyInstance, ctx: WebContext) {
  app.get('/api/admin/slots', async (req) => {
    await requireAdmin(ctx, req)
    const query = req.query as { q?: string; limit?: string; offset?: string }
    const slots = query.q
      ? await ctx.repos.slots.search(query.q, Number(query.limit ?? 100))
      : await ctx.repos.slots.list(Number(query.limit ?? 100), Number(query.offset ?? 0))
    return { slots }
  })

  app.post('/api/admin/slots', async (req) => {
    await requireAdmin(ctx, req)
    const body = z
      .object({
        name: z.string().min(1).max(120),
        provider: z.string().max(80).nullish(),
        rtp: z.number().min(0).max(100).nullish(),
        maxWin: z.number().int().min(0).nullish(),
        volatility: z.enum(['low', 'medium', 'high', 'very-high']).nullish(),
        thumbnail: z.string().url().nullish(),
        aliases: z.array(z.string().min(1).max(60)).optional(),
      })
      .parse(req.body)

    const slot = await ctx.repos.slots.upsert({
      name: body.name,
      provider: body.provider ?? null,
      rtp: body.rtp === null || body.rtp === undefined ? null : String(body.rtp),
      maxWin: body.maxWin ?? null,
      volatility: body.volatility ?? null,
      thumbnail: body.thumbnail ?? null,
    })

    for (const alias of body.aliases ?? []) {
      await ctx.repos.aliases.learn({ slotId: slot.id, alias, source: 'manual', approved: true })
    }

    ctx.catalog.invalidate()
    return { slot }
  })

  app.patch('/api/admin/slots/:id', async (req) => {
    await requireAdmin(ctx, req)
    const { id } = req.params as { id: string }
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        provider: z.string().max(80).nullish(),
        rtp: z.number().min(0).max(100).nullish(),
        maxWin: z.number().int().min(0).nullish(),
        volatility: z.string().nullish(),
        thumbnail: z.string().url().nullish(),
      })
      .parse(req.body)

    await ctx.repos.slots.update(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.provider !== undefined ? { provider: body.provider ?? null } : {}),
      ...(body.rtp !== undefined ? { rtp: body.rtp === null ? null : String(body.rtp) } : {}),
      ...(body.maxWin !== undefined ? { maxWin: body.maxWin ?? null } : {}),
      ...(body.volatility !== undefined ? { volatility: body.volatility ?? null } : {}),
      ...(body.thumbnail !== undefined ? { thumbnail: body.thumbnail ?? null } : {}),
    } as never)

    ctx.catalog.invalidate()
    return { ok: true }
  })

  app.delete('/api/admin/slots/:id', async (req) => {
    await requireAdmin(ctx, req)
    const { id } = req.params as { id: string }
    await ctx.repos.slots.remove(id)
    ctx.catalog.invalidate()
    return { ok: true }
  })

  app.get('/api/admin/slots/:id/aliases', async (req) => {
    await requireAdmin(ctx, req)
    const { id } = req.params as { id: string }
    return { aliases: await ctx.repos.aliases.forSlot(id) }
  })

  /**
   * §21 — the alias review queue, "sorted by frequency so the highest-impact
   * fixes come first, with 1/2/3/D keyboard shortcuts because it's worked in
   * bulk."
   */
  app.get('/api/admin/aliases/queue', async (req) => {
    await requireAdmin(ctx, req)
    const limit = Number((req.query as { limit?: string }).limit ?? 50)
    return { queue: await ctx.repos.aliases.reviewQueue(limit) }
  })

  app.post('/api/admin/aliases/:id/approve', async (req) => {
    await requireAdmin(ctx, req)
    const { id } = req.params as { id: string }
    await ctx.repos.aliases.approve(id)
    ctx.catalog.invalidate()
    return { ok: true }
  })

  app.post('/api/admin/aliases/:id/reject', async (req) => {
    await requireAdmin(ctx, req)
    const { id } = req.params as { id: string }
    await ctx.repos.aliases.reject(id)
    ctx.catalog.invalidate()
    return { ok: true }
  })

  /**
   * §6.3 — "Track daily delivery volume per channel on the admin dashboard, so
   * you watch the ceiling approach rather than discovering it mid-stream."
   */
  app.get('/api/admin/quota', async (req) => {
    await requireAdmin(ctx, req)
    const days = Number((req.query as { days?: string }).days ?? 14)
    const [rows, today] = await Promise.all([
      ctx.repos.quota.recent(days),
      ctx.repos.quota.todayTotal(),
    ])
    return { days: rows, todayTotal: today }
  })

  app.get('/api/admin/channels', async (req) => {
    await requireAdmin(ctx, req)
    const channels = await ctx.repos.channels.list(500)

    return {
      channels: await Promise.all(
        channels.map(async (channel) => {
          const active = await ctx.repos.sessions.activeForChannel(channel.id)
          const subs = await ctx.repos.subscriptions.activeForChannel(channel.id)
          return {
            id: channel.id,
            slug: channel.slug,
            broadcasterUserId: channel.broadcasterUserId,
            activeSession: active
              ? { id: active.id, gameId: active.gameId, phase: active.phase }
              : null,
            // A channel with subscriptions but no session is exactly the leak
            // §6.3 warns about, so it's surfaced rather than buried.
            liveSubscriptions: subs.length,
            leaking: subs.length > 0 && active === null,
          }
        }),
      ),
    }
  })

  app.get('/api/admin/health', async (req) => {
    await requireAdmin(ctx, req)
    const [ingest, chat, timer, lookup] = await Promise.all([
      ctx.queues.ingest.getJobCounts(),
      ctx.queues.chat.getJobCounts(),
      ctx.queues.timer.getJobCounts(),
      ctx.queues.lookup.getJobCounts(),
    ])
    const active = await ctx.repos.sessions.allActive()

    return {
      queues: { ingest, chat, timer, lookup },
      activeSessions: active.length,
      games: ctx.registry.ids(),
      catalogFuzzy: ctx.env.CATALOG_FUZZY,
    }
  })

  /** Force-end a session the operator can see is stuck. */
  app.post('/api/admin/sessions/:id/end', async (req) => {
    await requireAdmin(ctx, req)
    const { id } = req.params as { id: string }
    await ctx.queues.ingest.add('end', {
      kind: 'end',
      sessionId: id,
      reason: 'abandoned',
      at: Date.now(),
    })
    return { ok: true }
  })

  /** Manually trigger the boot-time reconcile (§12) without a redeploy. */
  app.post('/api/admin/reconcile', async (req) => {
    await requireAdmin(ctx, req)
    await ctx.queues.maintenance.add('reconcile-subscriptions', {
      kind: 'reconcile-subscriptions',
    })
    return { ok: true, queued: true }
  })
}
