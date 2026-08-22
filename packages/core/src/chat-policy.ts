/**
 * Chat policy (§15). Applied by the runtime to effects a game returned, so
 * every game inherits "only speak when useful" for free.
 *
 *   Off | Errors only (default) | Batched summaries | Every request
 *
 * With errors-only, 300 viewers spamming !sr collapses from 300 outbound writes
 * to maybe 5-15 across the whole session.
 */

import type { AckMode, ChatPolicy } from '@streamarena/shared'
import type { ChatEffect, Priority } from './effects.js'

export type ChatDecision =
  | { send: 'now'; effect: ChatEffect }
  | { send: 'batched'; effect: ChatEffect }
  | { send: 'delayed'; effect: ChatEffect; delayMs: number }
  | { send: 'drop'; reason: 'ack_mode' | 'announcements_off' | 'empty' }

const PRIORITY_ORDER: Record<Priority, number> = {
  announce: 0,
  error: 1,
  reply: 2,
  ack: 3,
  batched: 4,
}

export function comparePriority(a: Priority, b: Priority): number {
  return PRIORITY_ORDER[a] - PRIORITY_ORDER[b]
}

/** Does this ack survive the streamer's setting? */
function allowedByAckMode(priority: Priority, mode: AckMode): boolean {
  if (priority === 'announce') return true
  switch (mode) {
    case 'off':
      return false
    case 'errors':
      return priority === 'error' || priority === 'reply'
    case 'batched':
      return true
    case 'all':
      return true
  }
}

export function decideChat(effect: ChatEffect, policy: ChatPolicy): ChatDecision {
  const text = effect.text.trim()
  if (text === '') return { send: 'drop', reason: 'empty' }

  if (effect.priority === 'announce') {
    if (!policy.announceResults) return { send: 'drop', reason: 'announcements_off' }
    // §15.3 — hold the write so chat doesn't spoil the overlay reveal.
    const delayMs = effect.holdForStreamDelay === false ? 0 : policy.streamDelayMs
    return delayMs > 0
      ? { send: 'delayed', effect, delayMs }
      : { send: 'now', effect }
  }

  if (!allowedByAckMode(effect.priority, policy.ackMode)) {
    return { send: 'drop', reason: 'ack_mode' }
  }

  // Errors and direct answers go out promptly — a viewer waiting on "did my
  // entry land?" is exactly the case acks exist for.
  if (effect.priority === 'error' || effect.priority === 'reply') {
    return { send: 'now', effect }
  }

  // 'batched' mode coalesces even plain acks; 'all' sends them individually.
  if (policy.ackMode === 'batched') return { send: 'batched', effect }
  return effect.priority === 'batched' ? { send: 'batched', effect } : { send: 'now', effect }
}

export const KICK_MAX_CHAT_CHARS = 500

/**
 * Coalesce a batch window's worth of acks into one <=500 char write (§15.5).
 * Same batchKey collapses; anything that doesn't fit is returned for the next
 * window rather than silently dropped.
 */
export function coalesce(
  effects: readonly ChatEffect[],
  limit = KICK_MAX_CHAT_CHARS,
): { text: string; used: ChatEffect[]; deferred: ChatEffect[] } {
  const seen = new Set<string>()
  const parts: string[] = []
  const used: ChatEffect[] = []
  const deferred: ChatEffect[] = []
  let length = 0

  for (const e of effects) {
    const key = e.batchKey ?? e.text
    if (seen.has(key)) {
      used.push(e)
      continue
    }
    const piece = e.text.trim()
    const added = parts.length === 0 ? piece.length : piece.length + 3 // " · "
    if (length + added > limit) {
      deferred.push(e)
      continue
    }
    seen.add(key)
    parts.push(piece)
    used.push(e)
    length += added
  }

  return { text: parts.join(' · '), used, deferred }
}

/**
 * §15.5 — "Vary text on repeats. Kick's anti-spam drops identical consecutive
 * messages." An invisible zero-width variation would be sneaky; a rotating
 * suffix is honest and reads as natural.
 */
export function varyIfRepeat(text: string, previous: string | null, nonce: number): string {
  if (previous === null || text !== previous) return text
  const suffixes = ['', ' ·', ' ~', ' —', ' ··']
  const suffix = suffixes[nonce % suffixes.length] ?? ''
  const candidate = `${text}${suffix}`
  return candidate.length <= KICK_MAX_CHAT_CHARS ? candidate : text
}

export function truncate(text: string, limit = KICK_MAX_CHAT_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}
