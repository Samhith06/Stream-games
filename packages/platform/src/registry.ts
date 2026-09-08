import { GameRegistry, type AnyGameModule } from '@streamarena/core'
import { bonusHunt } from '@streamarena/game-bonus-hunt'
import { slotTournament } from '@streamarena/game-slot-tournament'
import { slotBingo } from '@streamarena/game-slot-bingo'
import { teamBattles } from '@streamarena/game-team-battles'
import { giveaways } from '@streamarena/game-giveaways'

/**
 * The one place games are wired in — §7.
 *
 * Adding game #3 is a single line here plus a package. If it ever needs more
 * than that, the GameModule contract is missing an abstraction.
 */
export function buildRegistry(): GameRegistry {
  return new GameRegistry()
    .register(bonusHunt)
    .register(slotTournament)
    .register(slotBingo)
    .register(teamBattles)
    .register(giveaways)
}

/** Games announced but not yet playable, for the catalog's "Soon" cards. */
export const COMING_SOON = [
  { id: 'predictions', displayName: 'Predictions', tagline: 'Custom yes/no scenarios. Let the arena bet on your next big play.' },
  { id: 'guess-the-multiplier', displayName: 'Guess the Multiplier', tagline: 'A high-stakes guessing game tied to your current crash or slot run.' },
] as const

/**
 * Config fields that rename a command's keyword, by game.
 *
 * Same rule as the runtime's gate mapping, one field over: **a setup control
 * the runtime does not read is a lie on a form.** Giveaways' keyword is the
 * whole entry surface of that game and the spec expects it to be changed on
 * nearly every session — a streamer who sets `!drop`, watches the overlay say
 * `!drop`, and finds the bot still listening for `!enter` has a game that
 * simply does not work.
 *
 * Here rather than in the worker because the web app needs it too: two games
 * sharing a channel must not share a keyword, and that collision is refused at
 * session creation.
 *
 * Keyed by game id rather than by field name, because a bare `keyword` is too
 * generic a field name to claim globally.
 */
export const KEYWORD_FIELDS: Record<string, Record<string, string>> = {
  /** Giveaways §5 — "the most themeable string in the product." */
  giveaways: { keyword: 'enter' },
}

/** The command keyword overrides a session's own config implies. */
export function keywordsFor(
  gameId: string,
  config: Record<string, unknown>,
): Record<string, string[]> {
  const fields = KEYWORD_FIELDS[gameId]
  if (!fields) return {}

  const overrides: Record<string, string[]> = {}
  for (const [field, command] of Object.entries(fields)) {
    const keyword = config[field]
    if (typeof keyword !== 'string') continue
    // Stored without the prefix; the parser adds it. A leading '!' the streamer
    // typed anyway would otherwise produce a command nobody in chat can reach.
    const cleaned = keyword.trim().replace(/^!+/, '')
    if (cleaned !== '') overrides[command] = [cleaned]
  }
  return overrides
}

/**
 * Every keyword a session will actually listen for, normalised for comparison.
 *
 * The three sources, in the order they win: the channel's saved per-command
 * overrides, the session's own config (`keywordsFor`), and the game module's
 * declared defaults. This is what the parser ends up indexing, so it is the
 * only honest input to a collision check.
 */
export function sessionKeywords(
  game: AnyGameModule,
  config: Record<string, unknown>,
  commandOverrides: Record<string, string[]> = {},
): Set<string> {
  const fromConfig = keywordsFor(game.id, config)
  const out = new Set<string>()

  for (const spec of game.commands) {
    const keywords = fromConfig[spec.id] ?? commandOverrides[spec.id] ?? spec.keywords
    for (const keyword of keywords) out.add(keyword.trim().replace(/^!+/, '').toLowerCase())
  }

  return out
}
