/**
 * Redis pub/sub broadcast backplane — §8.
 *
 * "The moment you run more than one web instance, overlay sockets land on
 * arbitrary instances. Use Redis pub/sub as the broadcast backplane from day
 * one. Twenty lines now; painful retrofit later."
 *
 * The worker publishes; every web instance subscribes and fans out to the
 * sockets it happens to hold.
 */

import type { Redis } from 'ioredis'
import type { ServerFrame } from '@streamarena/shared'
import { KEY } from './redis.js'

export class OverlayBus {
  private handlers = new Map<string, Set<(frame: ServerFrame) => void>>()
  private subscribed = new Set<string>()

  /**
   * `publisher` and `subscriber` must be separate connections — a Redis client
   * in subscribe mode refuses ordinary commands.
   */
  constructor(
    private readonly publisher: Redis,
    private readonly subscriber?: Redis,
  ) {
    this.subscriber?.on('message', (channel, payload) => {
      const listeners = this.handlers.get(channel)
      if (!listeners || listeners.size === 0) return
      let frame: ServerFrame
      try {
        frame = JSON.parse(payload) as ServerFrame
      } catch {
        return
      }
      for (const fn of listeners) fn(frame)
    })
  }

  async publish(sessionId: string, frame: ServerFrame): Promise<void> {
    await this.publisher.publish(KEY.overlayChannel(sessionId), JSON.stringify(frame))
  }

  async subscribe(sessionId: string, handler: (frame: ServerFrame) => void): Promise<() => void> {
    if (!this.subscriber) throw new Error('OverlayBus was constructed without a subscriber')

    const channel = KEY.overlayChannel(sessionId)
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(handler)

    if (!this.subscribed.has(channel)) {
      await this.subscriber.subscribe(channel)
      this.subscribed.add(channel)
    }

    return () => {
      set!.delete(handler)
      // Unsubscribe once the last socket for this session goes away, so a busy
      // night doesn't leave thousands of dead channel subscriptions behind.
      if (set!.size === 0) {
        this.handlers.delete(channel)
        this.subscribed.delete(channel)
        void this.subscriber?.unsubscribe(channel).catch(() => {})
      }
    }
  }
}
