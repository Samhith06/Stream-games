/**
 * Effects are *returned*, never performed (§9).
 *
 * A reducer never calls sendChat(). It returns { kind: 'chat', ... } and the
 * runtime decides whether to batch it, throttle it, hold it behind the stream
 * delay, or drop it because the streamer turned acks off. Every game inherits
 * that policy for free.
 */

/**
 * Priority lanes — §15.5. Errors and announcements beat batched summaries.
 * `announce` additionally bypasses batching and is subject to the stream delay.
 *
 * `reply` answers a question a viewer explicitly asked (`!hunt`, `!myslot`,
 * `!score`). Those carry their own rate limits — §13 caps `!hunt` at one per
 * 60s per channel — so they are governed by that rather than by the ack
 * setting: a viewer who asks a direct question gets an answer unless chat
 * output is off entirely.
 */
export type Priority = 'announce' | 'error' | 'reply' | 'ack' | 'batched'

export interface ChatEffect {
  kind: 'chat'
  text: string
  /** Kick message id of the viewer's message — renders as a threaded reply. */
  replyTo?: string
  priority: Priority
  /**
   * §15.3 — hold this write until the stream delay has elapsed so chat doesn't
   * spoil the overlay reveal. Defaults to true for `announce`, false otherwise.
   */
  holdForStreamDelay?: boolean
  /**
   * Dedupe key for batched acks. Two effects with the same key inside one
   * batch window collapse into one write.
   */
  batchKey?: string
}

export interface BroadcastEffect {
  kind: 'broadcast'
  /** Shallow-merged into the overlay projection by top-level key. */
  patch: Record<string, unknown>
  /**
   * Keys only the dashboard should receive. Set by the runtime when it diffs
   * the two projections; a game never populates this itself.
   */
  dashboardPatch?: Record<string, unknown>
}

export interface TimerEffect {
  kind: 'timer'
  inMs: number
  /** Re-enters the pipeline as a `timer` event once fired. */
  event: unknown
  /**
   * Timers with the same id replace one another — re-arming a countdown does
   * not leave the old one to fire later.
   */
  id?: string
}

export interface CancelTimerEffect {
  kind: 'cancelTimer'
  id: string
}

export interface LookupEffect {
  kind: 'lookup'
  query: string
  /** Opaque continuation echoed back on the SlotResolved event. */
  then: unknown
}

export interface PersistEffect {
  kind: 'persist'
  record: unknown
}

export interface EndEffect {
  kind: 'end'
  reason?: 'complete' | 'abandoned'
}

export type Effect =
  | ChatEffect
  | BroadcastEffect
  | TimerEffect
  | CancelTimerEffect
  | LookupEffect
  | PersistEffect
  | EndEffect

export const chat = (
  text: string,
  opts: Omit<ChatEffect, 'kind' | 'text'> = { priority: 'ack' },
): ChatEffect => ({ kind: 'chat', text, ...opts })

export const ack = (text: string, replyTo?: string): ChatEffect => ({
  kind: 'chat',
  text,
  replyTo,
  priority: 'ack',
})

export const rejection = (text: string, replyTo?: string): ChatEffect => ({
  kind: 'chat',
  text,
  replyTo,
  priority: 'error',
})

/** Answers a question the viewer asked. See the note on Priority. */
export const reply = (text: string, replyTo?: string): ChatEffect => ({
  kind: 'chat',
  text,
  replyTo,
  priority: 'reply',
})

/** Top-level broadcast to the whole channel, held behind the stream delay. */
export const announce = (text: string): ChatEffect => ({
  kind: 'chat',
  text,
  priority: 'announce',
  holdForStreamDelay: true,
})

export const broadcast = (patch: Record<string, unknown>): BroadcastEffect => ({
  kind: 'broadcast',
  patch,
})

export const timer = (inMs: number, event: unknown, id?: string): TimerEffect => ({
  kind: 'timer',
  inMs,
  event,
  ...(id ? { id } : {}),
})

export const cancelTimer = (id: string): CancelTimerEffect => ({ kind: 'cancelTimer', id })

export const lookup = (query: string, then: unknown): LookupEffect => ({
  kind: 'lookup',
  query,
  then,
})

export const end = (reason: 'complete' | 'abandoned' = 'complete'): EndEffect => ({
  kind: 'end',
  reason,
})
