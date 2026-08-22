/**
 * The reducer harness (§9, §10 step 6).
 *
 * Pure in, pure out. No database, no Redis, no Kick. The worker wraps this; the
 * test suite calls it directly and simulates a 500-viewer spam storm in
 * milliseconds.
 */

import type { OverlayState } from '@streamarena/shared'
import type { Effect } from './effects.js'
import type { InternalEvent } from './events.js'
import type { GameModule, InitContext, ReduceContext } from './game-module.js'
import { rngFactory, type Rng } from './primitives/rng.js'
import { StateVersionMismatchError } from './registry.js'

export interface EngineOptions<TConfig> {
  config: TConfig
  init: InitContext
}

export interface Folded<TState> {
  state: TState
  effects: Effect[]
  seq: number
}

export class GameEngine<TState, TConfig> {
  private readonly rng: (label: string) => Rng
  readonly module: GameModule<TState, TConfig>
  readonly config: TConfig
  readonly init: InitContext

  constructor(module: GameModule<TState, TConfig>, opts: EngineOptions<TConfig>) {
    this.module = module
    this.config = opts.config
    this.init = opts.init
    this.rng = rngFactory(opts.init.seed)
  }

  initialState(): TState {
    return this.module.initialState(this.config, this.init)
  }

  /** Fold one event. The only place reduce() is ever called. */
  apply(state: TState, event: InternalEvent): Folded<TState> {
    const ctx: ReduceContext<TConfig> = {
      config: this.config,
      sessionId: this.init.sessionId,
      seq: event.seq,
      now: event.at,
      rng: this.rng,
      owner: this.init.owner,
    }
    const { state: next, effects } = this.module.reduce(state, event, ctx)
    return { state: next, effects, seq: event.seq }
  }

  /**
   * Rebuild state from a snapshot plus the events after it (§11).
   *
   * "A streamer reports 'the hunt lost three entries at 11pm' — you replay their
   * session locally and watch it happen." Effects produced during replay are
   * returned but must never be executed: the chat writes already went out.
   */
  replay(
    events: readonly InternalEvent[],
    from?: { state: TState; seq: number; stateVersion?: number },
  ): { state: TState; seq: number; effects: Effect[] } {
    if (from?.stateVersion !== undefined && from.stateVersion !== this.module.stateVersion) {
      throw new StateVersionMismatchError(
        this.module.id,
        this.module.stateVersion,
        from.stateVersion,
      )
    }

    let state = from?.state ?? this.initialState()
    let seq = from?.seq ?? 0
    const effects: Effect[] = []

    for (const event of events) {
      if (event.seq <= seq) continue // already folded into the snapshot
      const folded = this.apply(state, event)
      state = folded.state
      seq = folded.seq
      effects.push(...folded.effects)
    }

    return { state, seq, effects }
  }

  project(state: TState): OverlayState {
    return this.module.project(state)
  }

  projectDashboard(state: TState): OverlayState {
    return this.module.projectDashboard?.(state) ?? (state as unknown as OverlayState)
  }

  phaseOf(state: TState): string | null {
    return this.module.phaseOf?.(state) ?? null
  }
}

/** §11 — snapshot every N events so replay isn't O(all events). */
export function shouldSnapshot(seq: number, everyN: number): boolean {
  return everyN > 0 && seq > 0 && seq % everyN === 0
}
