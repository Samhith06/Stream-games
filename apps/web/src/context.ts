/**
 * Web composition root.
 *
 * §8: the web process "stays responsive; does almost no work". It owns HTTP and
 * WebSocket, verifies and enqueues, and reads projections. It never reduces a
 * game and never calls Kick on a request path except during OAuth.
 */

import { createDb, createRepos, type Repos } from '@streamarena/db'
import { SlotCatalog } from '@streamarena/catalog'
import { KickAuth, PublicKeyProvider, TokenCipher, TokenStore } from '@streamarena/kick'
import {
  buildRegistry,
  createLogger,
  createQueues,
  createRedis,
  loadEnv,
  OverlayBus,
  SessionCache,
  type Env,
  type Logger,
  type Queues,
} from '@streamarena/platform'
import type { GameRegistry } from '@streamarena/core'
import type { Redis } from 'ioredis'

export interface WebContext {
  env: Env
  log: Logger
  repos: Repos
  redis: Redis
  /** Fails fast instead of queueing — see createWebContext. */
  rateLimitRedis: Redis
  queues: Queues
  bus: OverlayBus
  cache: SessionCache
  registry: GameRegistry
  catalog: SlotCatalog
  auth: KickAuth
  tokens: TokenStore
  publicKeys: PublicKeyProvider
  close(): Promise<void>
}

export function createWebContext(): WebContext {
  const env = loadEnv()
  const log = createLogger({
    level: env.LOG_LEVEL,
    name: 'web',
    pretty: env.NODE_ENV === 'development',
  })

  // Fewer connections than the worker: this process should be waiting on
  // sockets, not on Postgres.
  const { db, close: closeDb } = createDb({ url: env.DATABASE_URL, max: 8 })
  const repos = createRepos(db)

  const redis = createRedis(env.REDIS_URL)
  const queueRedis = createRedis(env.REDIS_URL)
  /**
   * The rate limiter sits on the request path, so its connection must fail
   * rather than wait. The shared connection uses `maxRetriesPerRequest: null`
   * and an offline queue, which BullMQ needs and which is exactly wrong here: a
   * Redis blip would leave every /api request hanging on a queued command
   * instead of the limiter stepping aside.
   */
  const rateLimitRedis = createRedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500,
  })
  const publisher = createRedis(env.REDIS_URL)
  const subscriber = createRedis(env.REDIS_URL)

  const queues = createQueues(queueRedis)
  // §8 — Redis pub/sub as the broadcast backplane from day one, so overlay
  // sockets landing on arbitrary instances still receive every patch.
  const bus = new OverlayBus(publisher, subscriber)
  const cache = new SessionCache(redis)
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
  const publicKeys = new PublicKeyProvider(env.KICK_API_BASE, env.KICK_WEBHOOK_PUBLIC_KEY)

  return {
    env,
    log,
    repos,
    redis,
    rateLimitRedis,
    queues,
    bus,
    cache,
    registry,
    catalog,
    auth,
    tokens,
    publicKeys,
    async close() {
      await queues.close()
      await Promise.all([
        redis.quit(),
        rateLimitRedis.quit(),
        queueRedis.quit(),
        publisher.quit(),
        subscriber.quit(),
      ])
      await closeDb()
    },
  }
}
