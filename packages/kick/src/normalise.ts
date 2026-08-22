/**
 * Kick payload -> internal vocabulary — §10 step 2.
 *
 * The boundary that keeps Kick out of every other package. A game module can
 * never see a Kick shape, which is why adding Twitch later is additive.
 */

import type { Actor } from '@streamarena/core'
import type { ViewerRole } from '@streamarena/shared'
import {
  chatMessageSentSchema,
  kicksGiftedSchema,
  livestreamStatusSchema,
  subscriptionEventSchema,
  type KickUser,
} from './types.js'

export interface NormalisedChatMessage {
  kind: 'chat'
  broadcasterUserId: string
  messageId: string
  text: string
  actor: Actor
  repliesToMessageId: string | null
}

export interface NormalisedChannelEvent {
  kind: 'subscription' | 'gift' | 'kicks' | 'livestream'
  broadcasterUserId: string
  actor: Actor
  payload: Record<string, unknown>
}

export type NormalisedKickEvent = NormalisedChatMessage | NormalisedChannelEvent

/**
 * Kick badges are the only role signal on a chat message. Rank highest-first:
 * a broadcaster also carries a moderator badge on some payloads.
 */
export function roleFromUser(user: KickUser): ViewerRole {
  const badges = user.identity?.badges ?? []
  const types = new Set(badges.map((b) => b.type.toLowerCase()))
  if (types.has('broadcaster')) return 'broadcaster'
  if (types.has('moderator')) return 'moderator'
  if (types.has('subscriber') || types.has('founder') || types.has('sub_gifter')) {
    return 'subscriber'
  }
  // Kick does not put a follower badge on messages. Follower gating therefore
  // needs a channel lookup; until that exists, treat unbadged as 'viewer' and
  // let a `followers` gate behave as `anyone` rather than locking chat out.
  return 'viewer'
}

function actorOf(user: KickUser): Actor {
  return {
    userId: String(user.user_id),
    // §15.5 — capture the username at submission time; Kick usernames change.
    username: user.username,
    role: roleFromUser(user),
  }
}

export function normalise(eventType: string, payload: unknown): NormalisedKickEvent | null {
  switch (eventType) {
    case 'chat.message.sent': {
      const parsed = chatMessageSentSchema.safeParse(payload)
      if (!parsed.success) return null
      const d = parsed.data
      return {
        kind: 'chat',
        broadcasterUserId: String(d.broadcaster.user_id),
        messageId: d.message_id,
        text: d.content,
        actor: actorOf(d.sender),
        repliesToMessageId: d.replies_to?.message_id ?? null,
      }
    }

    case 'channel.subscription.new':
    case 'channel.subscription.renewal':
    case 'channel.subscription.gifts': {
      const parsed = subscriptionEventSchema.safeParse(payload)
      if (!parsed.success) return null
      const d = parsed.data
      const who = d.subscriber ?? d.gifter ?? d.broadcaster
      return {
        kind: 'subscription',
        broadcasterUserId: String(d.broadcaster.user_id),
        actor: actorOf(who),
        payload: {
          duration: d.duration ?? null,
          giftees: (d.giftees ?? []).map((g) => ({
            userId: String(g.user_id),
            username: g.username,
          })),
        },
      }
    }

    case 'kicks.gifted': {
      const parsed = kicksGiftedSchema.safeParse(payload)
      if (!parsed.success) return null
      const d = parsed.data
      return {
        kind: 'kicks',
        broadcasterUserId: String(d.broadcaster.user_id),
        actor: actorOf(d.sender),
        payload: { gift: d.gift ?? null },
      }
    }

    case 'livestream.status.updated': {
      const parsed = livestreamStatusSchema.safeParse(payload)
      if (!parsed.success) return null
      const d = parsed.data
      return {
        kind: 'livestream',
        broadcasterUserId: String(d.broadcaster.user_id),
        actor: actorOf(d.broadcaster),
        payload: { isLive: d.is_live, title: d.title ?? null },
      }
    }

    default:
      return null
  }
}
