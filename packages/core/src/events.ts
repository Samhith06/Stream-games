import type { ViewerRole } from '@streamarena/shared'

/**
 * The normalised event vocabulary a game reducer sees. Kick's wire shapes never
 * reach a game module — `packages/kick` translates into these and nothing else.
 *
 * Every event carries `at` (wall clock, captured at ingest and persisted in the
 * log). Reducers read time from the event, never from Date.now(), so a replay
 * of the log reproduces the session exactly.
 */

export interface Actor {
  userId: string
  /** Username captured at submission time — Kick usernames change mid-session. */
  username: string
  role: ViewerRole
}

interface BaseEvent {
  /** Monotonic per session. Assigned at commit time. */
  seq: number
  /** Wall clock at ingest, ms since epoch. The reducer's only clock. */
  at: number
}

/** Session opened. Games use this to arm opening countdowns. */
export interface SessionStartedEvent extends BaseEvent {
  type: 'session.started'
}

/** A viewer typed a recognised command that survived every guard. */
export interface CommandEvent extends BaseEvent {
  type: 'command'
  /** Canonical command id, e.g. 'sr' — not the keyword the viewer typed. */
  command: string
  /** Everything after the keyword, trimmed. */
  args: string
  /** The full original message, for the unresolved queue and audit. */
  raw: string
  actor: Actor
  /** Kick message id — fed back as reply_to_message_id for threaded acks. */
  messageId: string
}

/** The streamer or a dashboard client did something. Never comes from chat. */
export interface ControlEvent extends BaseEvent {
  type: 'control'
  action: string
  payload: Record<string, unknown>
  actor: Actor
}

/** A previously scheduled TimerEffect fired. */
export interface TimerEvent extends BaseEvent {
  type: 'timer'
  /** Echo of TimerEffect.event. */
  payload: unknown
  timerId?: string
}

/** Result of a LookupEffect coming back into the pipeline. */
export interface SlotResolvedEvent extends BaseEvent {
  type: 'slot.resolved'
  query: string
  /** Echo of LookupEffect.then. */
  then: unknown
  match: {
    slotId: string
    name: string
    provider: string | null
    thumbnail: string | null
    confidence: number
  } | null
  suggestions: {
    slotId: string
    name: string
    provider: string | null
    thumbnail: string | null
    confidence: number
  }[]
}

/** Kick platform events a game opted into via `subscriptions`. */
export interface ChannelEvent extends BaseEvent {
  type: 'channel.subscription' | 'channel.gift' | 'channel.kicks'
  actor: Actor
  payload: Record<string, unknown>
}

export interface SessionEndedEvent extends BaseEvent {
  type: 'session.ended'
  reason: 'complete' | 'abandoned'
}

export type InternalEvent =
  | SessionStartedEvent
  | CommandEvent
  | ControlEvent
  | TimerEvent
  | SlotResolvedEvent
  | ChannelEvent
  | SessionEndedEvent

export type InternalEventType = InternalEvent['type']

/** Kick event types a game can declare — drives webhook subscription scope. */
export type KickEventType =
  | 'chat.message.sent'
  | 'channel.subscription.new'
  | 'channel.subscription.renewal'
  | 'channel.subscription.gifts'
  | 'kicks.gifted'
  | 'livestream.status.updated'
