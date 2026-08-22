/**
 * The starter catalog.
 *
 * Covers what a gambling stream's chat actually shouts — the titles in regular
 * rotation across the providers that community plays — rather than trying to be
 * a complete database. §21's flywheel handles the long tail: an unmatched
 * request becomes an alias suggestion the streamer approves, and custom slots
 * can be added from the dashboard.
 *
 * Hand-maintained, so treat a wrong provider as a bug worth fixing rather than
 * a fact. Re-seeded on every release via ensure(), which never disturbs the
 * usage statistics the resolution ladder ranks on.
 *
 * Aliases are the shorthand people type, not every substring — the resolver
 * already normalises case, punctuation and spacing, so 'gates of olympus',
 * 'Gates Of Olympus' and 'gatesofolympus' all match the name on their own. An
 * alias earns its place only when it is something a name match would miss.
 * Avoid aliases that could plausibly mean two different slots; an ambiguous
 * alias is worse than none, because it resolves confidently to the wrong game.
 */

export interface SeedSlot {
  name: string
  provider: string
  aliases: string[]
}

const PRAGMATIC = 'Pragmatic Play'
const HACKSAW = 'Hacksaw Gaming'
const NOLIMIT = 'Nolimit City'
const PUSH = 'Push Gaming'
const RELAX = 'Relax Gaming'
const PLAYNGO = "Play'n GO"
const NETENT = 'NetEnt'
const BTG = 'Big Time Gaming'
const RED_TIGER = 'Red Tiger'
const BLUEPRINT = 'Blueprint Gaming'
const ELK = 'ELK Studios'
const THUNDERKICK = 'Thunderkick'
const AVATARUX = 'AvatarUX'
const GAMES_GLOBAL = 'Games Global'
const YGGDRASIL = 'Yggdrasil'
const QUICKSPIN = 'Quickspin'
const EVOLUTION = 'Evolution'

export const SEED_SLOTS: SeedSlot[] = [
  // ── Pragmatic Play ────────────────────────────────────────────────────────
  { name: 'Gates of Olympus', provider: PRAGMATIC, aliases: ['gates', 'goo', 'zeus', 'gate'] },
  { name: 'Gates of Olympus 1000', provider: PRAGMATIC, aliases: ['gates 1000', 'goo1000', 'gates1k'] },
  { name: 'Sweet Bonanza', provider: PRAGMATIC, aliases: ['bonanza', 'sweet', 'candy'] },
  { name: 'Sweet Bonanza 1000', provider: PRAGMATIC, aliases: ['sweet 1000', 'sb1000', 'sweet1k'] },
  { name: 'Sugar Rush', provider: PRAGMATIC, aliases: ['sugar'] },
  { name: 'Sugar Rush 1000', provider: PRAGMATIC, aliases: ['sugar 1000', 'sr1000', 'sugar1k'] },
  { name: 'Starlight Princess', provider: PRAGMATIC, aliases: ['princess', 'starlight'] },
  { name: 'Starlight Princess 1000', provider: PRAGMATIC, aliases: ['princess 1000', 'sp1000'] },
  { name: 'The Dog House', provider: PRAGMATIC, aliases: ['doghouse', 'dogs'] },
  { name: 'The Dog House Megaways', provider: PRAGMATIC, aliases: ['doghouse mw', 'dhmw'] },
  { name: 'The Dog House Multihold', provider: PRAGMATIC, aliases: ['doghouse multihold', 'dh multihold'] },
  { name: 'Big Bass Bonanza', provider: PRAGMATIC, aliases: ['bigbass', 'bass', 'fish'] },
  { name: 'Bigger Bass Bonanza', provider: PRAGMATIC, aliases: ['bigger bass', 'bbb'] },
  { name: 'Big Bass Splash', provider: PRAGMATIC, aliases: ['bass splash', 'splash'] },
  { name: 'Wild West Gold', provider: PRAGMATIC, aliases: ['wwg', 'wildwest'] },
  { name: 'Zeus vs Hades', provider: PRAGMATIC, aliases: ['zvh', 'hades'] },
  { name: 'Fruit Party', provider: PRAGMATIC, aliases: ['fruit'] },
  { name: 'Gems Bonanza', provider: PRAGMATIC, aliases: ['gems'] },
  { name: 'Release the Kraken', provider: PRAGMATIC, aliases: ['kraken', 'rtk'] },
  { name: 'Buffalo King Megaways', provider: PRAGMATIC, aliases: ['buffalo king', 'bkmw'] },
  { name: 'Wolf Gold', provider: PRAGMATIC, aliases: ['wolf'] },
  { name: 'Great Rhino Megaways', provider: PRAGMATIC, aliases: ['rhino', 'grmw'] },
  { name: 'Power of Thor Megaways', provider: PRAGMATIC, aliases: ['thor', 'potm'] },
  { name: 'Curse of the Werewolf Megaways', provider: PRAGMATIC, aliases: ['werewolf', 'cotw'] },
  { name: 'Floating Dragon', provider: PRAGMATIC, aliases: ['floating'] },
  { name: 'Fire Strike', provider: PRAGMATIC, aliases: ['firestrike'] },
  { name: 'Madame Destiny Megaways', provider: PRAGMATIC, aliases: ['madame destiny', 'mdmw'] },
  { name: 'John Hunter and the Tomb of the Scarab Queen', provider: PRAGMATIC, aliases: ['john hunter', 'scarab queen', 'tomb'] },

  // ── Hacksaw Gaming ────────────────────────────────────────────────────────
  { name: 'Wanted Dead or a Wild', provider: HACKSAW, aliases: ['wanted', 'wdoaw'] },
  { name: 'Le Bandit', provider: HACKSAW, aliases: ['bandit'] },
  { name: 'Le Pharaoh', provider: HACKSAW, aliases: ['pharaoh'] },
  { name: 'Chaos Crew', provider: HACKSAW, aliases: ['chaos'] },
  { name: 'Chaos Crew 2', provider: HACKSAW, aliases: ['chaos 2', 'cc2'] },
  { name: 'Rip City', provider: HACKSAW, aliases: ['rip'] },
  { name: 'Hand of Anubis', provider: HACKSAW, aliases: ['anubis', 'hoa'] },
  { name: 'Duel at Dawn', provider: HACKSAW, aliases: ['duel', 'dad'] },
  { name: 'Stormforged', provider: HACKSAW, aliases: ['storm forged'] },
  { name: 'Dork Unit', provider: HACKSAW, aliases: ['dork'] },
  { name: 'Cursed Crypt', provider: HACKSAW, aliases: ['crypt'] },
  { name: 'Toshi Video Club', provider: HACKSAW, aliases: ['toshi'] },
  { name: 'Fruit Duel', provider: HACKSAW, aliases: ['fruitduel'] },
  { name: 'Beast Mode', provider: HACKSAW, aliases: ['beast'] },
  { name: 'Densho', provider: HACKSAW, aliases: [] },
  { name: 'Blood & Shadow', provider: HACKSAW, aliases: ['bns'] },
  { name: 'Rocket Reels', provider: HACKSAW, aliases: ['rocket'] },
  { name: 'Wanted Dead or a Wild 2', provider: HACKSAW, aliases: ['wanted 2', 'wdoaw2'] },

  // ── Nolimit City ──────────────────────────────────────────────────────────
  { name: 'San Quentin xWays', provider: NOLIMIT, aliases: ['sanquentin', 'sq', 'quentin'] },
  { name: 'San Quentin 2', provider: NOLIMIT, aliases: ['sq2'] },
  { name: 'Mental', provider: NOLIMIT, aliases: ['mental 1'] },
  { name: 'Mental 2', provider: NOLIMIT, aliases: ['mental2'] },
  { name: 'Fire in the Hole xBomb', provider: NOLIMIT, aliases: ['fith', 'fire in the hole', 'fireinthehole'] },
  { name: 'Fire in the Hole 2', provider: NOLIMIT, aliases: ['fith2'] },
  { name: 'Deadwood', provider: NOLIMIT, aliases: ['dead wood'] },
  { name: 'Tombstone RIP', provider: NOLIMIT, aliases: ['tombstone', 'trip'] },
  { name: 'Tombstone No Mercy', provider: NOLIMIT, aliases: ['no mercy', 'tnm'] },
  { name: 'Punk Rocker', provider: NOLIMIT, aliases: ['punk'] },
  { name: 'Punk Rocker 2', provider: NOLIMIT, aliases: ['punk 2', 'pr2'] },
  { name: 'Karen Maneater', provider: NOLIMIT, aliases: ['karen'] },
  { name: 'Das xBoot', provider: NOLIMIT, aliases: ['xboot', 'das boot'] },
  { name: 'Misery Mining', provider: NOLIMIT, aliases: ['misery'] },
  { name: 'Folsom Prison', provider: NOLIMIT, aliases: ['folsom'] },
  { name: 'East Coast vs West Coast', provider: NOLIMIT, aliases: ['ecvwc', 'east coast'] },
  { name: 'Serial', provider: NOLIMIT, aliases: [] },
  { name: 'Disturbed', provider: NOLIMIT, aliases: [] },
  { name: 'Book of Shadows', provider: NOLIMIT, aliases: ['bos', 'shadows'] },
  { name: 'Dead Canary', provider: NOLIMIT, aliases: ['canary'] },
  { name: 'Brick Snake 2000', provider: NOLIMIT, aliases: ['brick snake', 'bs2000'] },
  { name: 'Road Rage', provider: NOLIMIT, aliases: ['roadrage'] },
  { name: 'Infectious 5 xWays', provider: NOLIMIT, aliases: ['infectious'] },
  { name: 'Xways Hoarder xSplit', provider: NOLIMIT, aliases: ['hoarder', 'xways hoarder'] },

  // ── Push Gaming ───────────────────────────────────────────────────────────
  { name: 'Razor Shark', provider: PUSH, aliases: ['razor'] },
  { name: 'Razor Returns', provider: PUSH, aliases: ['razor 2', 'returns'] },
  { name: "Jammin' Jars", provider: PUSH, aliases: ['jars', 'jammin'] },
  { name: "Jammin' Jars 2", provider: PUSH, aliases: ['jj2'] },
  { name: 'Mystery Museum', provider: PUSH, aliases: ['museum'] },
  { name: 'Fat Banker', provider: PUSH, aliases: ['banker'] },
  { name: 'Fat Rabbit', provider: PUSH, aliases: ['rabbit'] },
  { name: 'Fat Santa', provider: PUSH, aliases: ['santa'] },
  { name: 'Big Bamboo', provider: PUSH, aliases: ['bamboo'] },
  { name: 'Wild Swarm', provider: PUSH, aliases: ['swarm'] },
  { name: 'Retro Tapes', provider: PUSH, aliases: ['tapes'] },
  { name: 'Dinopolis', provider: PUSH, aliases: ['dino'] },

  // ── Relax Gaming ──────────────────────────────────────────────────────────
  { name: 'Money Train 2', provider: RELAX, aliases: ['mt2'] },
  { name: 'Money Train 3', provider: RELAX, aliases: ['mt3'] },
  { name: 'Money Train 4', provider: RELAX, aliases: ['mt4', 'moneytrain', 'money train'] },
  { name: 'Temple Tumble Megaways', provider: RELAX, aliases: ['temple tumble', 'ttmw'] },
  { name: 'Temple Tumble 2 Megaways', provider: RELAX, aliases: ['temple tumble 2', 'tt2'] },
  { name: "Dead Man's Trail", provider: RELAX, aliases: ['dead mans trail', 'dmt'] },
  { name: 'Snake Arena', provider: RELAX, aliases: ['snake'] },
  { name: 'Hellcatraz', provider: RELAX, aliases: ['hell catraz'] },
  { name: 'Iron Bank', provider: RELAX, aliases: ['ironbank'] },
  { name: 'Marching Legions', provider: RELAX, aliases: ['legions'] },

  // ── Play'n GO ─────────────────────────────────────────────────────────────
  { name: 'Book of Dead', provider: PLAYNGO, aliases: ['bod', 'book'] },
  { name: 'Reactoonz', provider: PLAYNGO, aliases: ['reactoon', 'reactoonz 1'] },
  { name: 'Reactoonz 2', provider: PLAYNGO, aliases: ['reactoonz2'] },
  { name: 'Rise of Olympus 100', provider: PLAYNGO, aliases: ['roo', 'rise'] },
  { name: 'Fire Joker', provider: PLAYNGO, aliases: ['joker'] },
  { name: 'Moon Princess', provider: PLAYNGO, aliases: ['moon'] },
  { name: 'Moon Princess 100', provider: PLAYNGO, aliases: ['moon 100', 'mp100'] },
  { name: 'Legacy of Dead', provider: PLAYNGO, aliases: ['lod'] },
  { name: 'Honey Rush', provider: PLAYNGO, aliases: ['honey'] },
  { name: 'Gemix', provider: PLAYNGO, aliases: [] },
  { name: 'Sweet Alchemy', provider: PLAYNGO, aliases: ['alchemy'] },

  // ── NetEnt ────────────────────────────────────────────────────────────────
  { name: 'Dead or Alive 2', provider: NETENT, aliases: ['doa2', 'doa', 'dead or alive'] },
  { name: "Gonzo's Quest", provider: NETENT, aliases: ['gonzo', 'gonzos quest'] },
  { name: 'Starburst', provider: NETENT, aliases: ['star burst'] },
  { name: 'Divine Fortune', provider: NETENT, aliases: ['divine'] },
  { name: 'Blood Suckers', provider: NETENT, aliases: ['bloodsuckers'] },
  { name: 'Twin Spin', provider: NETENT, aliases: ['twinspin'] },

  // ── Big Time Gaming ───────────────────────────────────────────────────────
  { name: 'Bonanza Megaways', provider: BTG, aliases: ['bonanza mw', 'btg bonanza'] },
  { name: 'Danger High Voltage', provider: BTG, aliases: ['dhv', 'danger'] },
  { name: 'Extra Chilli', provider: BTG, aliases: ['chilli', 'extra chili'] },
  { name: 'White Rabbit Megaways', provider: BTG, aliases: ['white rabbit', 'wrmw'] },
  { name: 'The Final Countdown', provider: BTG, aliases: ['final countdown', 'tfc'] },
  { name: 'Apollo Pays Megaways', provider: BTG, aliases: ['apollo'] },
  { name: 'Star Clusters Megaclusters', provider: BTG, aliases: ['star clusters'] },

  // ── Red Tiger ─────────────────────────────────────────────────────────────
  { name: 'Mystic Mirror', provider: RED_TIGER, aliases: ['mystic'] },
  { name: "Gonzo's Quest Megaways", provider: RED_TIGER, aliases: ['gonzo mw', 'gqmw'] },
  { name: 'Piggy Riches Megaways', provider: RED_TIGER, aliases: ['piggy riches', 'prmw'] },
  { name: "Dragon's Luck", provider: RED_TIGER, aliases: ['dragons luck'] },

  // ── Blueprint Gaming ──────────────────────────────────────────────────────
  { name: 'Eye of Horus', provider: BLUEPRINT, aliases: ['horus', 'eoh'] },
  { name: "Fishin' Frenzy", provider: BLUEPRINT, aliases: ['frenzy'] },
  { name: "Fishin' Frenzy Megaways", provider: BLUEPRINT, aliases: ['frenzy mw', 'ffmw'] },
  { name: 'Diamond Mine', provider: BLUEPRINT, aliases: ['diamond'] },
  { name: 'King Kong Cash', provider: BLUEPRINT, aliases: ['king kong', 'kkc'] },
  { name: 'Buffalo Rising Megaways', provider: BLUEPRINT, aliases: ['buffalo rising', 'brmw'] },
  { name: 'Ted', provider: BLUEPRINT, aliases: [] },

  // ── ELK Studios ───────────────────────────────────────────────────────────
  { name: 'Nitropolis 3', provider: ELK, aliases: ['nitro 3', 'nitropolis3'] },
  { name: 'Nitropolis 4', provider: ELK, aliases: ['nitro 4', 'nitropolis4'] },
  { name: 'Cygnus 3', provider: ELK, aliases: ['cygnus3'] },
  { name: 'Cygnus 4', provider: ELK, aliases: ['cygnus4'] },
  { name: 'Pirots 2', provider: ELK, aliases: ['pirots2'] },
  { name: 'Pirots 3', provider: ELK, aliases: ['pirots3'] },
  { name: 'Wild Toro 2', provider: ELK, aliases: ['toro 2', 'wildtoro2'] },

  // ── Thunderkick ───────────────────────────────────────────────────────────
  { name: 'Midnight Marauder', provider: THUNDERKICK, aliases: ['marauder'] },
  { name: 'Esqueleto Explosivo 2', provider: THUNDERKICK, aliases: ['esqueleto', 'ee2'] },
  { name: 'Pink Elephants 2', provider: THUNDERKICK, aliases: ['pink elephants', 'pe2'] },

  // ── AvatarUX ──────────────────────────────────────────────────────────────
  { name: 'HippoPop', provider: AVATARUX, aliases: ['hippo'] },
  { name: 'CherryPop', provider: AVATARUX, aliases: ['cherry'] },
  { name: 'PopRocks', provider: AVATARUX, aliases: ['pop rocks'] },

  // ── Games Global ──────────────────────────────────────────────────────────
  { name: 'Immortal Romance', provider: GAMES_GLOBAL, aliases: ['immortal'] },
  { name: 'Immortal Romance II', provider: GAMES_GLOBAL, aliases: ['immortal 2', 'ir2'] },
  { name: 'Thunderstruck II', provider: GAMES_GLOBAL, aliases: ['thunderstruck', 'ts2'] },

  // ── Yggdrasil ─────────────────────────────────────────────────────────────
  { name: 'Vikings Go Berzerk', provider: YGGDRASIL, aliases: ['vikings', 'vgb'] },
  { name: 'Valley of the Gods', provider: YGGDRASIL, aliases: ['valley'] },

  // ── Quickspin ─────────────────────────────────────────────────────────────
  { name: 'Big Bad Wolf', provider: QUICKSPIN, aliases: ['bbw', 'big bad'] },
  { name: 'Sakura Fortune', provider: QUICKSPIN, aliases: ['sakura'] },

  // ── Evolution (live) ──────────────────────────────────────────────────────
  { name: 'Crazy Time', provider: EVOLUTION, aliases: ['crazytime', 'ct'] },
  { name: 'Monopoly Big Baller', provider: EVOLUTION, aliases: ['big baller', 'monopoly'] },
  { name: 'Lightning Roulette', provider: EVOLUTION, aliases: ['lightning'] },
  { name: 'Funky Time', provider: EVOLUTION, aliases: ['funky'] },
  { name: 'Sweet Bonanza CandyLand', provider: EVOLUTION, aliases: ['candyland'] },
]
