/**
 * Webhook quota telemetry — §6.3.
 *
 * "Track daily delivery volume per channel on the admin dashboard, so you watch
 * the ceiling approach rather than discovering it mid-stream."
 *
 * Counters are incremented on a per-day, per-channel row. The hot path buffers
 * these in Redis and flushes here periodically; a lost flush costs accuracy on
 * a dashboard, never correctness of a game.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { channels, webhookQuotaDaily } from '../schema.js'

export type QuotaCounter = 'deliveries' | 'commands' | 'dropped' | 'chatWrites' | 'chatFailures'

const COLUMN: Record<QuotaCounter, string> = {
  deliveries: 'deliveries',
  commands: 'commands',
  dropped: 'dropped',
  chatWrites: 'chat_writes',
  chatFailures: 'chat_failures',
}

export class QuotaRepository {
  constructor(private readonly db: Database) {}

  /**
   * Values are bound through Drizzle's `sql` template; the only raw fragment is
   * a column name drawn from the fixed COLUMN map, never from caller input.
   */
  async increment(
    channelId: string | null,
    counter: QuotaCounter,
    amount = 1,
    day: Date = new Date(),
  ): Promise<void> {
    if (amount === 0) return
    const isoDay = day.toISOString().slice(0, 10)
    const col = sql.raw(COLUMN[counter])
    await this.db.execute(sql`
      INSERT INTO webhook_quota_daily (day, channel_id, ${col})
      VALUES (${isoDay}::date, ${channelId}::uuid, ${amount})
      ON CONFLICT (day, channel_id)
      DO UPDATE SET ${col} = webhook_quota_daily.${col} + ${amount}
    `)
  }

  async incrementMany(
    channelId: string | null,
    counts: Partial<Record<QuotaCounter, number>>,
    day: Date = new Date(),
  ): Promise<void> {
    for (const [counter, amount] of Object.entries(counts) as [QuotaCounter, number][]) {
      await this.increment(channelId, counter, amount, day)
    }
  }

  async recent(days = 14) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return this.db
      .select({
        day: webhookQuotaDaily.day,
        channelId: webhookQuotaDaily.channelId,
        slug: channels.slug,
        deliveries: webhookQuotaDaily.deliveries,
        commands: webhookQuotaDaily.commands,
        dropped: webhookQuotaDaily.dropped,
        chatWrites: webhookQuotaDaily.chatWrites,
        chatFailures: webhookQuotaDaily.chatFailures,
      })
      .from(webhookQuotaDaily)
      .leftJoin(channels, eq(channels.id, webhookQuotaDaily.channelId))
      .where(gte(webhookQuotaDaily.day, since))
      .orderBy(desc(webhookQuotaDaily.day))
  }

  async todayTotal(): Promise<number> {
    const today = new Date().toISOString().slice(0, 10)
    const [row] = await this.db
      .select({ total: sql<number>`COALESCE(SUM(deliveries), 0)::int` })
      .from(webhookQuotaDaily)
      .where(eq(webhookQuotaDaily.day, today))
    return row?.total ?? 0
  }

  async forChannel(channelId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return this.db
      .select()
      .from(webhookQuotaDaily)
      .where(and(eq(webhookQuotaDaily.channelId, channelId), gte(webhookQuotaDaily.day, since)))
      .orderBy(desc(webhookQuotaDaily.day))
  }
}
