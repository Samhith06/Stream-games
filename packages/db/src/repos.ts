import type { Database } from './client.js'
import { SessionRepository } from './repositories/sessions.js'
import { EventRepository } from './repositories/events.js'
import {
  ChannelRepository,
  GameConfigRepository,
  SubscriptionRepository,
  TokenRepository,
  UserRepository,
} from './repositories/users.js'
import { QuotaRepository } from './repositories/quota.js'
import { AliasRepository, SlotRepository } from './repositories/slots.js'

/** One handle passed around the apps, rather than eight constructor arguments. */
export interface Repos {
  db: Database
  users: UserRepository
  tokens: TokenRepository
  channels: ChannelRepository
  configs: GameConfigRepository
  subscriptions: SubscriptionRepository
  sessions: SessionRepository
  events: EventRepository
  quota: QuotaRepository
  slots: SlotRepository
  aliases: AliasRepository
}

export function createRepos(db: Database): Repos {
  return {
    db,
    users: new UserRepository(db),
    tokens: new TokenRepository(db),
    channels: new ChannelRepository(db),
    configs: new GameConfigRepository(db),
    subscriptions: new SubscriptionRepository(db),
    sessions: new SessionRepository(db),
    events: new EventRepository(db),
    quota: new QuotaRepository(db),
    slots: new SlotRepository(db),
    aliases: new AliasRepository(db),
  }
}
