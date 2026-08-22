/**
 * Guard chain — step 5 of the pipeline (§10). Ordered, fail fast:
 *
 *   session accepting? -> command enabled? -> role gate
 *   -> per-user cooldown -> per-user cap -> global cap
 *
 * Guards are the runtime's job, not the game's. A game declares intent on the
 * CommandSpec; the runtime enforces it identically for every game.
 *
 * State that must survive a worker restart (cooldowns, counters) lives behind
 * `GuardStore` so the worker can back it with Redis and tests can back it with
 * a Map.
 */

import type { RoleGate, ViewerRole } from '@streamarena/shared'
import type { CommandSpec } from './game-module.js'
import type { Actor } from './events.js'

export type GuardDenial =
  | { reason: 'session_closed' }
  | { reason: 'command_disabled' }
  | { reason: 'role_gate'; required: RoleGate }
  | { reason: 'cooldown'; retryInMs: number }
  | { reason: 'per_user_limit'; limit: number }
  | { reason: 'global_limit'; limit: number }

export type GuardVerdict = { allowed: true } | { allowed: false; denial: GuardDenial }

const ALLOWED: GuardVerdict = { allowed: true }

export interface GuardStore {
  /** ms remaining on this viewer's cooldown, 0 if none. */
  cooldownRemaining(sessionId: string, commandId: string, userId: string): Promise<number>
  startCooldown(sessionId: string, commandId: string, userId: string, ms: number): Promise<void>
  /** Successful uses by this viewer of this command in this session. */
  userCount(sessionId: string, commandId: string, userId: string): Promise<number>
  /** Successful uses of this command in this session, by everyone. */
  globalCount(sessionId: string, commandId: string): Promise<number>
  /** Called only after reduce() succeeds — rejections never consume quota. */
  recordUse(sessionId: string, commandId: string, userId: string): Promise<void>
  clearSession(sessionId: string): Promise<void>
}

const ROLE_RANK: Record<ViewerRole, number> = {
  viewer: 0,
  follower: 1,
  subscriber: 2,
  moderator: 3,
  broadcaster: 4,
}

const GATE_RANK: Record<RoleGate, number> = {
  anyone: 0,
  followers: 1,
  subscribers: 2,
  moderators: 3,
}

export function satisfiesGate(role: ViewerRole, gate: RoleGate): boolean {
  return ROLE_RANK[role] >= GATE_RANK[gate]
}

export interface GuardInput {
  sessionId: string
  spec: CommandSpec
  actor: Actor
  /** False once the session has ended or the game stopped accepting input. */
  sessionAccepting: boolean
  /** Per-channel command toggles from game_configs. */
  enabled: boolean
  /**
   * Per-channel gate override. A streamer can tighten `!sr` to subscribers
   * without the game knowing anything about it.
   */
  gateOverride?: RoleGate
}

export async function runGuards(store: GuardStore, input: GuardInput): Promise<GuardVerdict> {
  const { sessionId, spec, actor } = input

  if (!input.sessionAccepting) return deny({ reason: 'session_closed' })
  if (!input.enabled) return deny({ reason: 'command_disabled' })

  // Moderators and the broadcaster bypass cooldowns and caps entirely — they're
  // running the session, not competing in it.
  const isOperator = actor.role === 'moderator' || actor.role === 'broadcaster'

  const gate = input.gateOverride ?? spec.gate
  if (!satisfiesGate(actor.role, gate)) return deny({ reason: 'role_gate', required: gate })

  if (isOperator) return ALLOWED

  if (spec.cooldownMs > 0) {
    const remaining = await store.cooldownRemaining(sessionId, spec.id, actor.userId)
    if (remaining > 0) return deny({ reason: 'cooldown', retryInMs: remaining })
  }

  if (spec.perUserLimit > 0) {
    const used = await store.userCount(sessionId, spec.id, actor.userId)
    if (used >= spec.perUserLimit) {
      return deny({ reason: 'per_user_limit', limit: spec.perUserLimit })
    }
  }

  if (spec.globalLimit > 0) {
    const used = await store.globalCount(sessionId, spec.id)
    if (used >= spec.globalLimit) {
      return deny({ reason: 'global_limit', limit: spec.globalLimit })
    }
  }

  return ALLOWED
}

function deny(denial: GuardDenial): GuardVerdict {
  return { allowed: false, denial }
}

/**
 * Denial text. §15.1 — these are exactly the cases where chat is the only
 * channel that works, so they're the messages that survive the errors-only
 * default.
 */
export function denialMessage(denial: GuardDenial, username: string): string {
  switch (denial.reason) {
    case 'session_closed':
      return `@${username} entries are closed for this one.`
    case 'command_disabled':
      return `@${username} that command is turned off right now.`
    case 'role_gate':
      return denial.required === 'subscribers'
        ? `@${username} this round is subscribers only.`
        : denial.required === 'followers'
          ? `@${username} follow the channel to join in.`
          : `@${username} you can't use that one.`
    case 'cooldown':
      return `@${username} slow down — try again in ${Math.ceil(denial.retryInMs / 1000)}s.`
    case 'per_user_limit':
      return denial.limit === 1
        ? `@${username} you're already in — one entry each.`
        : `@${username} you've used all ${denial.limit} of your entries.`
    case 'global_limit':
      return `@${username} that's the limit for this round.`
  }
}

/** In-memory GuardStore. Used by the reducer harness and every game test. */
export class MemoryGuardStore implements GuardStore {
  private cooldowns = new Map<string, number>()
  private counts = new Map<string, number>()
  constructor(private clock: () => number = () => Date.now()) {}

  private key(...parts: string[]) {
    return parts.join(':')
  }

  async cooldownRemaining(s: string, c: string, u: string): Promise<number> {
    const until = this.cooldowns.get(this.key(s, c, u)) ?? 0
    return Math.max(0, until - this.clock())
  }
  async startCooldown(s: string, c: string, u: string, ms: number): Promise<void> {
    this.cooldowns.set(this.key(s, c, u), this.clock() + ms)
  }
  async userCount(s: string, c: string, u: string): Promise<number> {
    return this.counts.get(this.key(s, c, u)) ?? 0
  }
  async globalCount(s: string, c: string): Promise<number> {
    return this.counts.get(this.key(s, c)) ?? 0
  }
  async recordUse(s: string, c: string, u: string): Promise<void> {
    this.counts.set(this.key(s, c, u), (this.counts.get(this.key(s, c, u)) ?? 0) + 1)
    this.counts.set(this.key(s, c), (this.counts.get(this.key(s, c)) ?? 0) + 1)
  }
  async clearSession(s: string): Promise<void> {
    for (const k of [...this.cooldowns.keys()]) if (k.startsWith(`${s}:`)) this.cooldowns.delete(k)
    for (const k of [...this.counts.keys()]) if (k.startsWith(`${s}:`)) this.counts.delete(k)
  }
}
