/**
 * Subscription manager — §6.3, §12.
 *
 * The binding constraint on the whole platform is inbound webhook volume, and
 * it's charged per delivery whether or not anyone typed a command. So:
 *
 *   1. Subscribe only while a game is running.
 *   2. Subscribe only to the event types the active game declares.
 *   3. Reconcile on boot — list Kick's subscriptions, drop orphans from
 *      crashed sessions.
 *
 * Rule 3 is what stops a crash from leaving a channel silently burning quota
 * for the rest of the day.
 */

import type { KickEventType } from '@streamarena/core'
import type { Repos } from '@streamarena/db'
import type { TokenStore } from './token-store.js'

export interface SubscriptionManagerDeps {
  repos: Repos
  tokens: TokenStore
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void
}

export class SubscriptionManager {
  constructor(private readonly deps: SubscriptionManagerDeps) {}

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    this.deps.log?.(level, msg, extra)
  }

  /** Called when a session starts. Idempotent — a retry won't double-subscribe. */
  async subscribeForSession(input: {
    sessionId: string
    channelId: string
    ownerUserId: string
    broadcasterUserId: string
    events: readonly KickEventType[]
  }): Promise<{ subscribed: number }> {
    const { repos, tokens } = this.deps

    const existing = await repos.subscriptions.activeForChannel(input.channelId)
    const have = new Set(existing.map((r) => r.eventType))
    const missing = input.events.filter((e) => !have.has(e))
    if (missing.length === 0) return { subscribed: 0 }

    const client = tokens.client(input.ownerUserId)
    const created = await client.subscribe({
      broadcasterUserId: input.broadcasterUserId,
      events: missing,
    })

    for (const sub of created) {
      await repos.subscriptions.record({
        channelId: input.channelId,
        sessionId: input.sessionId,
        kickSubscriptionId: sub.subscriptionId,
        eventType: sub.eventType,
      })
    }

    this.log('info', 'kick subscriptions created', {
      sessionId: input.sessionId,
      events: missing,
      count: created.length,
    })
    return { subscribed: created.length }
  }

  /**
   * Called when a session ends — including the abandoned path. Never leave a
   * subscription behind because the game ended unusually.
   */
  async unsubscribeForChannel(input: {
    channelId: string
    ownerUserId: string
  }): Promise<{ removed: number }> {
    const { repos, tokens } = this.deps
    const rows = await repos.subscriptions.activeForChannel(input.channelId)
    if (rows.length === 0) return { removed: 0 }

    const ids = rows.map((r) => r.kickSubscriptionId)
    try {
      await tokens.client(input.ownerUserId).unsubscribe(ids)
    } catch (err) {
      // Mark them deleted locally regardless. If Kick still holds them, the
      // boot reconcile will find and remove them; leaving the rows "active"
      // would make us skip re-subscribing on the next session.
      this.log('warn', 'kick unsubscribe failed, marking local rows deleted', {
        channelId: input.channelId,
        error: String(err),
      })
    }
    for (const id of ids) await repos.subscriptions.markDeleted(id)

    this.log('info', 'kick subscriptions removed', {
      channelId: input.channelId,
      count: ids.length,
    })
    return { removed: ids.length }
  }

  /**
   * Boot-time reconcile (§12). Compares what Kick thinks it's delivering with
   * what we believe we asked for, in both directions:
   *
   *   - Kick has it, no active session wants it -> delete at Kick (orphan).
   *   - We have a row, Kick doesn't know it     -> mark deleted locally (stale).
   */
  async reconcile(): Promise<{ orphansDropped: number; staleRowsCleared: number }> {
    const { repos, tokens } = this.deps

    const activeSessions = await repos.sessions.allActive()
    const wantedByChannel = new Map(activeSessions.map((s) => [s.channelId, s]))

    const channels = await repos.channels.list()
    let orphansDropped = 0
    let staleRowsCleared = 0

    for (const channel of channels) {
      let remote: Awaited<ReturnType<ReturnType<TokenStore['client']>['listSubscriptions']>>
      try {
        remote = await tokens.client(channel.ownerUserId).listSubscriptions()
      } catch (err) {
        this.log('warn', 'reconcile skipped for channel', {
          channelId: channel.id,
          error: String(err),
        })
        continue
      }

      const mine = remote.filter((r) => r.broadcasterUserId === channel.broadcasterUserId)
      const hasActiveSession = wantedByChannel.has(channel.id)

      if (!hasActiveSession && mine.length > 0) {
        try {
          await tokens.client(channel.ownerUserId).unsubscribe(mine.map((m) => m.subscriptionId))
          for (const m of mine) await repos.subscriptions.markDeleted(m.subscriptionId)
          orphansDropped += mine.length
          this.log('info', 'dropped orphaned subscriptions', {
            channelId: channel.id,
            count: mine.length,
          })
        } catch (err) {
          this.log('error', 'failed dropping orphaned subscriptions', {
            channelId: channel.id,
            error: String(err),
          })
        }
      }

      const remoteIds = new Set(mine.map((m) => m.subscriptionId))
      for (const row of await repos.subscriptions.activeForChannel(channel.id)) {
        if (!remoteIds.has(row.kickSubscriptionId)) {
          await repos.subscriptions.markDeleted(row.kickSubscriptionId)
          staleRowsCleared++
        }
      }
    }

    this.log('info', 'subscription reconcile complete', { orphansDropped, staleRowsCleared })
    return { orphansDropped, staleRowsCleared }
  }
}
