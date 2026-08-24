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
}

/** The command settings a session's config implies. */
export function gatesFor(config: Record<string, unknown>): Record<string, { gate: string }> {
  const settings: Record<string, { gate: string }> = {}
  for (const [key, command] of Object.entries(GATED_COMMANDS)) {
    const gate = config[key]
    if (typeof gate === 'string' && gate !== '') settings[command] = { gate }
  }
  return settings
}
