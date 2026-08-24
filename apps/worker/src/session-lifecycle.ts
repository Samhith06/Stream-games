/**
 * Session start and end.
 *
 * This is where §6.3's rule lives in code: "Subscribe only while a game is
 * running. Create the chat.message.sent subscription when a session starts;
 * delete it when the session ends. Never hold standing subscriptions on idle
 * channels."
 */

import { gatesFor } from './command-gates.js'
import { DEFAULT_CHAT_POLICY } from '@streamarena/shared'
import type { SessionMeta } from '@streamarena/platform'
import type { WorkerContext } from './context.js'
import { applyEvent, buildEngine, forgetSession } from './session-runner.js'
import { forgetCommandRegistry } from './router.js'

export async function startSession(ctx: WorkerContext, sessionId: string): Promise<void> {
  const session = await ctx.repos.sessions.byId(sessionId)
  if (!session) {
    ctx.log.warn({ sessionId }, 'start requested for an unknown session')
    return
  }
  if (session.status === 'ended' || session.status === 'abandoned') {
    ctx.log.warn({ sessionId }, 'start requested for a finished session')
    return
  }

  const channel = await ctx.repos.channels.byId(session.channelId)
  if (!channel) throw new Error(`Session ${sessionId} has no channel`)

  const owner = await ctx.repos.users.byId(channel.ownerUserId)
  if (!owner) throw new Error(`Channel ${channel.id} has no owner`)

  const game = ctx.registry.require(session.gameId)
  const config = await ctx.repos.configs.get(channel.id, session.gameId)

  const meta: SessionMeta = {
    sessionId: session.id,
    channelId: channel.id,
    broadcasterUserId: channel.broadcasterUserId,
    ownerUserId: owner.id,
    ownerUsername: owner.displayName,
    gameId: session.gameId,
    stateVersion: session.stateVersion,
    seed: session.seed,
    startedAt: session.startedAt?.getTime() ?? Date.now(),
    config: session.config,
    chatPolicy: { ...DEFAULT_CHAT_POLICY, ...(config?.chatPolicy ?? {}), ...(session.chatPolicy ?? {}) },
    commandOverrides: config?.commands ?? {},
    commandSettings: {},
    accepting: true,
  }

  // Per-game config can tighten a command's gate without the game knowing —
  // the Bonus Hunt setup screen's "Who can add slots?" is exactly this.
  // See command-gates.ts: every gate a setup screen offers must be mapped
  // there, or the control silently does nothing.
  meta.commandSettings = gatesFor(session.config as Record<string, unknown>)

  await ctx.cache.putMeta(meta)
  await ctx.repos.sessions.markRunning(session.id)

  // §6.3 — subscribe only to what this game declares it needs.
  try {
    await ctx.subscriptions.subscribeForSession({
      sessionId: session.id,
      channelId: channel.id,
      ownerUserId: owner.id,
      broadcasterUserId: channel.broadcasterUserId,
      events: game.subscriptions,
    })
  } catch (err) {
    // The session still runs — the dashboard works, the overlay works, and the
    // streamer can drive it by hand. Only chat input is missing, and saying so
    // beats refusing to start.
    ctx.log.error(
      { sessionId, err: String(err) },
      'failed to subscribe to Kick events; session runs without chat input',
    )
  }

  // Only on a genuinely new session. Recovery re-runs this function to rebuild
  // the cache, and a second session.started would re-arm every opening timer.
  if (Number(session.lastSeq) === 0) {
    await applyEvent(ctx, meta, { type: 'session.started', at: Date.now() })
  }

  // Seed the projection so an overlay connecting before the first event still
  // gets a real snapshot rather than an empty frame.
  const engine = buildEngine(ctx, meta)
  const projection = await ctx.cache.projection(session.id)
  if (!projection) {
    await ctx.cache.putProjection(session.id, 0, engine.project(engine.initialState()))
  }

  ctx.log.info({ sessionId, gameId: session.gameId, channelId: channel.id }, 'session started')
}

export async function endSession(
  ctx: WorkerContext,
  sessionId: string,
  reason: 'complete' | 'abandoned',
): Promise<void> {
  const session = await ctx.repos.sessions.byId(sessionId)
  if (!session || session.status === 'ended' || session.status === 'abandoned') return

  const meta = await ctx.cache.meta(sessionId)
  const channel = await ctx.repos.channels.byId(session.channelId)

  if (meta) {
    // One last frame so an overlay left on screen shows the finished state
    // rather than freezing mid-game.
    const projection = await ctx.cache.projection(sessionId)
    await ctx.bus.publish(sessionId, {
      t: 'ended',
      sessionId,
      seq: projection?.seq ?? 0,
      reason,
      serverTime: Date.now(),
    })
    // The final projection stays readable for a moment after the pointer is
    // cleared, so an overlay reconnecting on the ended frame still renders the
    // result rather than an empty card.
  }

  await ctx.repos.sessions.end(sessionId, reason === 'complete' ? 'ended' : 'abandoned')

  // §6.3 — the subscription must go, whether the session finished cleanly or
  // was abandoned. A standing subscription on an idle channel burns quota all
  // day for nothing.
  if (channel) {
    await ctx.subscriptions
      .unsubscribeForChannel({ channelId: channel.id, ownerUserId: channel.ownerUserId })
      .catch((err) => ctx.log.error({ sessionId, err: String(err) }, 'unsubscribe failed'))
  }

  if (meta) await ctx.cache.clear(meta)
  await ctx.guards.clearSession(sessionId)
  forgetSession(sessionId)
  forgetCommandRegistry(sessionId)

  ctx.log.info({ sessionId, reason }, 'session ended')
}

/**
 * Boot recovery. A worker that died mid-hunt left sessions marked running; this
 * restores their cache entries so the next chat message routes correctly
 * instead of being dropped as "no active session".
 */
export async function recoverActiveSessions(ctx: WorkerContext): Promise<number> {
  const active = await ctx.repos.sessions.allActive()
  let recovered = 0

  for (const session of active) {
    const cached = await ctx.cache.meta(session.id)
    if (cached) continue
    try {
      await startSession(ctx, session.id)
      recovered++
    } catch (err) {
      ctx.log.error({ sessionId: session.id, err: String(err) }, 'failed to recover session')
    }
  }

  if (recovered > 0) ctx.log.info({ recovered }, 'recovered sessions after restart')
  return recovered
}
