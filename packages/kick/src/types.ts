/**
 * Kick wire shapes. These never leave this package — `normalise.ts` translates
 * them into the core event vocabulary, which is what makes Twitch support
 * additive later rather than a rewrite (§12).
 */

import { z } from 'zod'

export const kickIdentitySchema = z.object({
  username_color: z.string().nullish(),
  badges: z
    .array(z.object({ type: z.string(), text: z.string().nullish(), count: z.number().nullish() }))
    .nullish(),
})

export const kickUserSchema = z.object({
  user_id: z.union([z.number(), z.string()]),
  username: z.string(),
  is_verified: z.boolean().nullish(),
  profile_picture: z.string().nullish(),
  channel_slug: z.string().nullish(),
  identity: kickIdentitySchema.nullish(),
})

/** `chat.message.sent` — the event that carries every command (§6.1). */
export const chatMessageSentSchema = z.object({
  message_id: z.string(),
  broadcaster: kickUserSchema,
  sender: kickUserSchema,
  content: z.string(),
  emotes: z.array(z.unknown()).nullish(),
  replies_to: z
    .object({ message_id: z.string(), content: z.string().nullish() })
    .nullish(),
  created_at: z.string().nullish(),
})

export const subscriptionEventSchema = z.object({
  broadcaster: kickUserSchema,
  subscriber: kickUserSchema.nullish(),
  gifter: kickUserSchema.nullish(),
  giftees: z.array(kickUserSchema).nullish(),
  duration: z.number().nullish(),
  created_at: z.string().nullish(),
  expires_at: z.string().nullish(),
})

export const kicksGiftedSchema = z.object({
  broadcaster: kickUserSchema,
  sender: kickUserSchema,
  gift: z
    .object({ gift_id: z.string().nullish(), name: z.string().nullish(), amount: z.number().nullish() })
    .nullish(),
  created_at: z.string().nullish(),
})

export const livestreamStatusSchema = z.object({
  broadcaster: kickUserSchema,
  is_live: z.boolean(),
  title: z.string().nullish(),
  started_at: z.string().nullish(),
  ended_at: z.string().nullish(),
})

export type KickUser = z.infer<typeof kickUserSchema>
export type ChatMessageSent = z.infer<typeof chatMessageSentSchema>
export type SubscriptionEvent = z.infer<typeof subscriptionEventSchema>
export type KicksGifted = z.infer<typeof kicksGiftedSchema>
export type LivestreamStatus = z.infer<typeof livestreamStatusSchema>

/** Headers Kick sets on every webhook delivery. */
export interface KickWebhookHeaders {
  messageId: string
  subscriptionId: string
  signature: string
  timestamp: string
  eventType: string
  eventVersion: string
}

export const KICK_HEADER = {
  messageId: 'kick-event-message-id',
  subscriptionId: 'kick-event-subscription-id',
  signature: 'kick-event-signature',
  timestamp: 'kick-event-message-timestamp',
  eventType: 'kick-event-type',
  eventVersion: 'kick-event-version',
} as const
