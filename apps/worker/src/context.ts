/**
 * Worker composition root. Everything the worker needs, constructed once.
 */

import { createDb, createRepos, type Repos } from '@streamarena/db'
import { SlotCatalog } from '@streamarena/catalog'
import {
  KickAuth,
  SubscriptionManager,
  TokenCipher,
  TokenStore,
} from '@streamarena/kick'
import {
  createLogger,
  createQueues,
  createRedis,
  loadEnv,
  OverlayBus,
  RedisGuardStore,
  SessionCache,
  buildRegistry,
  type Env,
  type Logger,
  type Queues,
} from '@streamarena/platform'
import type { GameRegistry, GuardStore } from '@streamarena/core'
import type { Redis } from 'ioredis'

export interface WorkerContext {
  env: Env
  log: Logger
  repos: Repos
  redis: Redis
  queues: Queues
  bus: OverlayBus
  cache: SessionCache
  guards: GuardStore
  registry: GameRegistry
  catalog: SlotCatalog
  tokens: TokenStore
  subscriptions: SubscriptionManager
  close(): Promise<void>
}

export function createContext(): WorkerContext {
  const env = loadEnv()
  const log = createLogger({
    level: env.LOG_LEVEL,
    name: 'worker',
    pretty: env.NODE_ENV === 'development',
  })

  const { db, close: closeDb } = createDb({ url: env.DATABASE_URL, max: 20 })
  const repos = createRepos(db)

  // Three connections on purpose: BullMQ blocks its own, and a client in
  // subscribe mode refuses ordinary commands (§8).
  const redis = createRedis(env.REDIS_URL)
  const queueRedis = createRedis(env.REDIS_URL)
  const publisher = createRedis(env.REDIS_URL)

  const queues = createQueues(queueRedis)
  const bus = new OverlayBus(publisher)
  const cache = new SessionCache(redis)
  const guards = new RedisGuardStore(redis)
  const registry = buildRegistry()

  const catalog = new SlotCatalog(repos.slots, repos.aliases, { fuzzy: env.CATALOG_FUZZY })

  const cipher = new TokenCipher(env.TOKEN_ENCRYPTION_KEY)
  const auth = new KickAuth({
    clientId: env.KICK_CLIENT_ID,
    clientSecret: env.KICK_CLIENT_SECRET,
    redirectUri: env.KICK_REDIRECT_URI,
    idBase: env.KICK_ID_BASE,
  })
  const tokens = new TokenStore(repos, cipher, auth, env.KICK_API_BASE)

  const subscriptions = new SubscriptionManager({
    repos,
    tokens,
    log: (level, msg, extra) => log[level](extra ?? {}, msg),
  })

  return {
    env,
    log,
    repos,
    redis,
    queues,
    bus,
    cache,
    guards,
    registry,
    catalog,
    tokens,
    subscriptions,
    async close() {
      await queues.close()
      await Promise.all([redis.quit(), queueRedis.quit(), publisher.quit()])
      await closeDb()
    },
  }
}
