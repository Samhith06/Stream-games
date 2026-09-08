/**
 * Which config field tightens which chat command.
 *
 * Its own file, and free of relative imports, so a test can read it from source
 * and cross-check it against what the games actually offer.
 *
 * The rule this exists to hold: **every gate a setup screen offers must appear
 * here.** If it doesn't, the control is a lie — the streamer picks
 * "Subscribers", the form saves it, the summary reports it, and chat is never
 * restricted at all. Team Battles' `sideGate` shipped exactly that way: the
 * setting was in the schema and on the form, and every viewer could still
 * declare a side.
 *
 * A missing entry cannot fail loudly on its own, because the failure is silence
 * — so the check is a test rather than a runtime assertion.
 */
export const GATED_COMMANDS: Record<string, string> = {
  /** Bonus Hunt — "Who can add slots?" */
  srGate: 'sr',
  /** Tournament, Bingo, Team Battles — who may enter the pool. */
  joinGate: 'join',
  /** Team Battles §7 — who may declare an allegiance. */
  sideGate: 'side',
  /*
   * Giveaways' `entryGate` is deliberately NOT here, and that absence is the
   * exception that proves the rule this file exists for.
   *
   * A runtime gate denial produces a chat write, and Giveaways §5 is absolute
   * that nothing is ever acked to an individual entrant: eight hundred entries
   * in a follower-gated session would produce eight hundred rejections, which
   * is outside Kick's rate limits and would be the worst thing that ever
   * happened to that channel's chat. So the gate lives inside that game's
   * reducer, where a rejection is counted into an aggregate silently and
   * reported once, batched, at thirty seconds remaining.
   *
   * The control is therefore honoured — just not here. `gateVerdict` in
   * `packages/games/giveaways/src/reduce.ts` is the enforcement point, and the
   * cross-check test knows to skip this one.
   */
}

/**
 * Gates that are deliberately enforced inside a game rather than by the runtime.
 *
 * The point of this list is that it is *short* and that adding to it costs an
 * argument. The cross-check test refuses any gate that is neither mapped above
 * nor named here, so a gate cannot become unenforced by omission — only by a
 * decision somebody wrote down.
 */
export const SELF_ENFORCED_GATES: Record<string, string> = {
  'giveaways.entryGate':
    'Giveaways §5 — a runtime denial writes to chat, and this game never acks an entrant. ' +
    'Enforced silently in gateVerdict() and reported as one batched summary.',
}

/**
 * Config fields that rename a command's keyword.
 *
 * Same rule as `GATED_COMMANDS`, one field over — but it lives in
 * `@streamarena/platform` rather than here, because the **web** app needs it
 * too: two games sharing a channel must not share a keyword, and the collision
 * check runs at session creation, before the worker has seen anything.
 *
 * Re-exported so this file stays the one place to look for "what does a setup
 * control actually do", and so the cross-check test can hold both halves to the
 * same standard.
 */
export { KEYWORD_FIELDS, keywordsFor, sessionKeywords } from '@streamarena/platform'

/**
 * The gate value meaning "no viewer runs this at all".
 *
 * Not a role, so it cannot be expressed as one — it turns the command off
 * instead. Team Battles uses it to run the crowd layer purely on assignment:
 * everyone who enters gets a side and nobody argues with it.
 */
export const NOBODY = 'nobody'

/** The command settings a session's config implies. */
export function gatesFor(
  config: Record<string, unknown>,
): Record<string, { enabled?: boolean; gate?: string }> {
  const settings: Record<string, { enabled?: boolean; gate?: string }> = {}

  for (const [key, command] of Object.entries(GATED_COMMANDS)) {
    const gate = config[key]
    if (typeof gate !== 'string' || gate === '') continue

    // Disabled rather than gated to an impossible role, so the router's own
    // "this command is off" path handles it and the denial reads correctly.
    settings[command] = gate === NOBODY ? { enabled: false } : { gate }
  }

  return settings
}
