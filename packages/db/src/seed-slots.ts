/**
 * A starter catalog. Enough that the first hunt on a fresh install resolves
 * most of what chat shouts, without pretending to be a complete database —
 * §21's flywheel does the rest.
 */

export interface SeedSlot {
  name: string
  provider: string
  aliases: string[]
}

export const SEED_SLOTS: SeedSlot[] = [
  { name: 'Gates of Olympus', provider: 'Pragmatic Play', aliases: ['gates', 'goo', 'zeus', 'gate'] },
  { name: 'Sweet Bonanza', provider: 'Pragmatic Play', aliases: ['bonanza', 'sweet', 'candy'] },
  { name: 'Sugar Rush', provider: 'Pragmatic Play', aliases: ['sugar'] },
  { name: 'Starlight Princess', provider: 'Pragmatic Play', aliases: ['princess', 'starlight'] },
  { name: 'The Dog House', provider: 'Pragmatic Play', aliases: ['doghouse', 'dogs'] },
  { name: 'Big Bass Bonanza', provider: 'Pragmatic Play', aliases: ['bigbass', 'bass', 'fish'] },
  { name: 'Wanted Dead or a Wild', provider: 'Hacksaw Gaming', aliases: ['wanted', 'wdoaw'] },
  { name: 'Le Bandit', provider: 'Hacksaw Gaming', aliases: ['bandit'] },
  { name: 'Chaos Crew', provider: 'Hacksaw Gaming', aliases: ['chaos'] },
  { name: 'Rip City', provider: 'Hacksaw Gaming', aliases: ['rip'] },
  { name: 'Hand of Anubis', provider: 'Hacksaw Gaming', aliases: ['anubis', 'hand'] },
  { name: 'Money Train 4', provider: 'Relax Gaming', aliases: ['mt4', 'moneytrain', 'money train'] },
  { name: 'Money Train 3', provider: 'Relax Gaming', aliases: ['mt3'] },
  { name: 'Dead or Alive 2', provider: "NetEnt", aliases: ['doa2', 'doa', 'dead or alive'] },
  { name: 'San Quentin xWays', provider: 'Nolimit City', aliases: ['sanquentin', 'sq', 'quentin'] },
  { name: 'Mental', provider: 'Nolimit City', aliases: ['mental 1'] },
  { name: 'Fire in the Hole xBomb', provider: 'Nolimit City', aliases: ['fith', 'fire in the hole', 'fireinthehole'] },
  { name: 'Tombstone RIP', provider: 'Nolimit City', aliases: ['tombstone', 'trip'] },
  { name: 'Punk Rocker', provider: 'Nolimit City', aliases: ['punk'] },
  { name: 'Book of Dead', provider: "Play'n GO", aliases: ['bod', 'book', 'book of dead'] },
  { name: 'Reactoonz', provider: "Play'n GO", aliases: ['reactoon', 'reactoonz 1'] },
  { name: 'Rise of Olympus 100', provider: "Play'n GO", aliases: ['roo', 'rise'] },
  { name: 'Bonanza Megaways', provider: 'Big Time Gaming', aliases: ['bonanza mw', 'btg bonanza'] },
  { name: 'Danger High Voltage', provider: 'Big Time Gaming', aliases: ['dhv', 'danger'] },
  { name: 'Wild West Gold', provider: 'Pragmatic Play', aliases: ['wwg', 'wildwest'] },
  { name: 'Crazy Time', provider: 'Evolution', aliases: ['crazytime', 'ct'] },
  { name: 'Zeus vs Hades', provider: 'Pragmatic Play', aliases: ['zvh', 'zeus vs hades', 'hades'] },
  { name: 'Duel at Dawn', provider: 'Hacksaw Gaming', aliases: ['duel', 'dad'] },
  { name: 'Mystic Mirror', provider: 'Red Tiger', aliases: ['mystic'] },
  { name: 'Eye of Horus', provider: 'Blueprint Gaming', aliases: ['horus', 'eoh'] },
]
