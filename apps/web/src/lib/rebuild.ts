/**
 * Rebuilds a finished session's projection from snapshot + log (§11).
 *
 * This is what makes the history and session-detail screens work for a session
 * from six months ago: nothing is stored pre-rendered, so a projection change
 * applies retroactively to every past session.
 */

import { GameEngine } from '@streamarena/core'
import { toInternalEvent } from '@streamarena/db'
import type { WebContext } from '../context.js'

export async function rebuildProjection(
  ctx: WebContext,
  sessionId: string,
  view: 'overlay' | 'dashboard' = 'dashboard',
): Promise<Record<string, unknown> | null> {
  const session = await ctx.repos.sessions.byId(sessionId)
  if (!session) return null

  const game = ctx.registry.get(session.gameId)
  if (!game) return null

  const channel = await ctx.repos.channels.byId(session.channelId)
  const owner = channel ? await ctx.repos.users.byId(channel.ownerUserId) : null

  const engine = new GameEngine(game, {
    config: session.config,
    init: {
      sessionId: session.id,
      channelId: session.channelId,
      seed: session.seed,
      startedAt: session.startedAt?.getTime() ?? session.createdAt.getTime(),
      owner: {
        userId: owner?.id ?? 'unknown',
        username: owner?.displayName ?? 'streamer',
        role: 'broadcaster',
      },
    },
  })

  const { snapshot, events } = await ctx.repos.events.loadForReplay(sessionId)

  try {
    const replayed = engine.replay(
      events.map(toInternalEvent),
      snapshot
        ? {
            state: snapshot.state as unknown,
            seq: Number(snapshot.seq),
            stateVersion: snapshot.stateVersion,
          }
        : undefined,
    )
    return (view === 'overlay'
      ? engine.project(replayed.state)
      : engine.projectDashboard(replayed.state)) as Record<string, unknown>
  } catch (err) {
    // A state-version mismatch: this session was written by an older shape of
    // the game. Refusing is right — a silently migrated log would answer "let
    // me replay your session" with a fiction (§11).
    ctx.log.warn({ sessionId, err: String(err) }, 'cannot replay session')
    return null
  }
}
