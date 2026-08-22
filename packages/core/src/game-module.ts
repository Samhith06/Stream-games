import type { z } from 'zod'
import type { OverlayState } from '@streamarena/shared'
import type { RoleGate } from '@streamarena/shared'
import type { Effect } from './effects.js'
import type { InternalEvent, KickEventType, Actor } from './events.js'
import type { Rng } from './primitives/rng.js'

/**
 * A command a game exposes to chat. Keywords are overridable per channel; the
 * `id` is what the reducer switches on, so renaming a keyword never touches
 * game code.
 */
export interface CommandSpec {
  id: string
  /** Default keyword, without the prefix. First entry is canonical. */
  keywords: string[]
  description: string
  /** Who may run it. The runtime enforces this before reduce() is called. */
  gate: RoleGate
  /** Per-viewer cooldown in ms. 0 disables. */
  cooldownMs: number
  /** Max successful uses per viewer per session. 0 = unlimited. */
  perUserLimit: number
  /** Max successful uses per session across everyone. 0 = unlimited. */
  globalLimit: number
  /** Commands the streamer/mods drive. Excluded from viewer-facing help. */
  operatorOnly?: boolean
}

/** Everything a game needs at construction time. Deterministic inputs only. */
export interface InitContext {
  sessionId: string
  channelId: string
  /** Session seed. All randomness derives from this — §9. */
  seed: string
  /** Wall clock at session creation, persisted with the session row. */
  startedAt: number
  /** The streamer, so a game can attribute the session without a lookup. */
  owner: Actor
}

export interface ReduceContext<TConfig> {
  config: TConfig
  sessionId: string
  /** Sequence of the event being folded. Games use this for ordering, not time. */
  seq: number
  /** Wall clock carried by the event. The reducer's only clock. */
  now: number
  /**
   * Deterministic RNG seeded from the session seed plus a caller-supplied
   * label. Same label, same session, same value — every time, on every replay.
   */
  rng: (label: string) => Rng
  /** The streamer's identity, for attribution in effect text. */
  owner: Actor
}

export interface ReduceResult<TState> {
  state: TState
  effects: Effect[]
}

/**
 * The most important interface in the system (§9).
 *
 * A game owns three things: what state it holds, how an event changes that
 * state, and what it renders. Nothing else. A game never touches Kick, never
 * opens a socket, never writes to Postgres.
 */
export interface GameModule<
  TState = unknown,
  TConfig = unknown,
  TEvent extends InternalEvent = InternalEvent,
> {
  readonly id: string
  /** Bump on any state shape change so replay can refuse mismatched logs. */
  readonly stateVersion: number
  readonly displayName: string
  readonly tagline: string

  /**
   * Renders the dashboard settings form and validates the POSTed config.
   *
   * The input type is left open because config schemas use `.default()`, so
   * what the dashboard POSTs is a partial of what the reducer receives.
   */
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, any>
  readonly commands: CommandSpec[]
  /** Drives the webhook subscription scope for sessions of this game. */
  readonly subscriptions: KickEventType[]

  initialState(config: TConfig, ctx: InitContext): TState

  /** Pure. No I/O. No Date.now(). No Math.random(). */
  reduce(state: TState, event: TEvent, ctx: ReduceContext<TConfig>): ReduceResult<TState>

  /** Strips anything viewers shouldn't see before it reaches the overlay. */
  project(state: TState): OverlayState

  /**
   * Optional: the dashboard shows more than the overlay does (unresolved
   * queue, raw pool, per-viewer detail). Defaults to the full state.
   */
  projectDashboard?(state: TState): OverlayState

  /** Optional: a short phase label for lists and the session banner. */
  phaseOf?(state: TState): string
}

/** Convenience alias for a fully-erased module held in the registry. */
export type AnyGameModule = GameModule<any, any, any>
