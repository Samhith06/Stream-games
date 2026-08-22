/**
 * History and session-detail derivations.
 *
 * Everything here is computed from the replayed projection rather than stored,
 * so the numbers on a six-month-old session always agree with the numbers the
 * live screen showed.
 */

import type { GameSessionRow } from '@streamarena/db'
import type { WebContext } from '../context.js'
import { rebuildProjection } from './rebuild.js'

export interface SessionSummaryDto {
  id: string
  gameId: string
  status: string
  phase: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  participantCount: number
  /** Bonus Hunt: bonuses collected. Tournament: entrants. */
  itemCount: number
  startBalance: number | null
  finalBalance: number | null
  profit: number | null
  bestSlot: { name: string; thumbnail: string | null; multiplier: number } | null
  /** Tournament only. */
  champion: { username: string; slotName: string } | null
}

export async function sessionSummary(
  ctx: WebContext,
  row: GameSessionRow,
): Promise<SessionSummaryDto> {
  const cached = await ctx.cache.projection(row.id)
  const state =
    (cached?.state as Record<string, unknown> | undefined) ??
    (await rebuildProjection(ctx, row.id)) ??
    {}

  const startedAt = row.startedAt ?? row.createdAt
  const endedAt = row.endedAt

  const startBalance = numberOrNull(state.startBalance)
  const finalBalance = numberOrNull(state.finalBalance)
  const spent = numberOrNull(state.spent)
  const won = numberOrNull(state.won)

  // Prefer the final balance when the hunt completed; fall back to won - spent
  // so an abandoned session still shows where it stood.
  const profit =
    finalBalance !== null && startBalance !== null
      ? round2(finalBalance - startBalance)
      : won !== null && spent !== null
        ? round2(won - spent)
        : null

  const best = state.bestEntry as { slotName?: string; multiplier?: number } | null | undefined
  const entries = Array.isArray(state.entries) ? state.entries : []
  const entrants = Array.isArray(state.entrants) ? state.entrants : []

  return {
    id: row.id,
    gameId: row.gameId,
    status: row.status,
    phase: row.phase,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
    durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
    participantCount: numberOrNull(state.participantCount) ?? 0,
    itemCount: entries.length || entrants.length,
    startBalance,
    finalBalance,
    profit,
    bestSlot: best?.slotName
      ? {
          name: best.slotName,
          thumbnail: thumbnailFor(entries, best.slotName),
          multiplier: best.multiplier ?? 0,
        }
      : null,
    champion: (state.champion as { username: string; slotName: string } | null) ?? null,
  }
}

export interface HistorySummary {
  totalSessions: number
  totalHunts: number
  bestResult: { profit: number; sessionId: string; date: string; slot: string | null } | null
  averageProfit: number | null
}

/** The four stat cards at the top of the history screen. */
export function summariseHistory(sessions: readonly SessionSummaryDto[]): HistorySummary {
  const withProfit = sessions.filter((s) => s.profit !== null)

  const best = withProfit.reduce<SessionSummaryDto | null>(
    (top, s) => (top === null || (s.profit ?? 0) > (top.profit ?? 0) ? s : top),
    null,
  )

  return {
    totalSessions: sessions.length,
    totalHunts: sessions.filter((s) => s.gameId === 'bonus-hunt').length,
    bestResult:
      best && best.profit !== null
        ? {
            profit: best.profit,
            sessionId: best.id,
            date: best.startedAt ?? '',
            slot: best.bestSlot?.name ?? null,
          }
        : null,
    averageProfit:
      withProfit.length === 0
        ? null
        : round2(withProfit.reduce((sum, s) => sum + (s.profit ?? 0), 0) / withProfit.length),
  }
}

/**
 * The session-detail extras: worst slot, most requested, and the audience
 * participation panel.
 */
export interface SessionAnalytics {
  worstSlot: { name: string; thumbnail: string | null; win: number; multiplier: number } | null
  mostRequested: { name: string; thumbnail: string | null; requests: number } | null
  uniqueChatters: number
  totalRequests: number
  topRequesters: { username: string; accepted: number }[]
}

export function analyseSession(state: Record<string, unknown>): SessionAnalytics {
  const entries = (Array.isArray(state.entries) ? state.entries : []) as Record<string, unknown>[]
  const opened = entries.filter((e) => e.status === 'opened')

  const worst = opened.reduce<Record<string, unknown> | null>(
    (low, e) =>
      low === null || (numberOrNull(e.multiplier) ?? 0) < (numberOrNull(low.multiplier) ?? 0)
        ? e
        : low,
    null,
  )

  // Duplicate slots in a hunt are normal and expected (§13), so "most
  // requested" counts across entries rather than assuming uniqueness.
  const bySlot = new Map<string, { name: string; thumbnail: string | null; requests: number }>()
  const byRequester = new Map<string, number>()

  for (const entry of entries) {
    const name = String(entry.slotName ?? '')
    if (name !== '') {
      const bucket = bySlot.get(name) ?? {
        name,
        thumbnail: (entry.thumbnail as string | null) ?? null,
        requests: 0,
      }
      bucket.requests += 1
      bySlot.set(name, bucket)
    }

    const requester = String(entry.requestedBy ?? '')
    if (requester !== '') byRequester.set(requester, (byRequester.get(requester) ?? 0) + 1)
  }

  const mostRequested = [...bySlot.values()].sort((a, b) => b.requests - a.requests)[0] ?? null

  return {
    worstSlot: worst
      ? {
          name: String(worst.slotName ?? ''),
          thumbnail: (worst.thumbnail as string | null) ?? null,
          win: numberOrNull(worst.win) ?? 0,
          multiplier: numberOrNull(worst.multiplier) ?? 0,
        }
      : null,
    mostRequested,
    uniqueChatters: numberOrNull(state.participantCount) ?? byRequester.size,
    totalRequests: entries.length,
    topRequesters: [...byRequester.entries()]
      .map(([username, accepted]) => ({ username, accepted }))
      .sort((a, b) => b.accepted - a.accepted)
      .slice(0, 5),
  }
}

function thumbnailFor(entries: unknown[], slotName: string): string | null {
  for (const entry of entries as Record<string, unknown>[]) {
    if (entry.slotName === slotName && typeof entry.thumbnail === 'string') return entry.thumbnail
  }
  return null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const round2 = (n: number) => Math.round(n * 100) / 100
