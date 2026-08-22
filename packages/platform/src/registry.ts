import { GameRegistry } from '@streamarena/core'
import { bonusHunt } from '@streamarena/game-bonus-hunt'
import { slotTournament } from '@streamarena/game-slot-tournament'

/**
 * The one place games are wired in — §7.
 *
 * Adding game #3 is a single line here plus a package. If it ever needs more
 * than that, the GameModule contract is missing an abstraction.
 */
export function buildRegistry(): GameRegistry {
  return new GameRegistry().register(bonusHunt).register(slotTournament)
}

/** Games announced but not yet playable, for the catalog's "Soon" cards. */
export const COMING_SOON = [
  { id: 'giveaways', displayName: 'Giveaways', tagline: 'Automated drops to active chatters based on watch time and engagement.' },
  { id: 'predictions', displayName: 'Predictions', tagline: 'Custom yes/no scenarios. Let the arena bet on your next big play.' },
  { id: 'guess-the-multiplier', displayName: 'Guess the Multiplier', tagline: 'A high-stakes guessing game tied to your current crash or slot run.' },
] as const
