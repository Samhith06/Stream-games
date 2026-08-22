/**
 * Kick REST client — §6.2, §12.
 *
 * Every outbound Kick call in the platform goes through here. It knows about
 * 429s and Retry-After (§15.5) but nothing about games, sessions or batching —
 * that policy lives in the worker's chat sender.
 */

import type { KickEventType } from '@streamarena/core'

export interface KickClientOptions {
  apiBase: string
  /** Resolves a fresh access token, refreshing it if it's close to expiry. */
  getAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
}

export interface SendChatInput {
  /** Omit for `type: 'bot'` — Kick ignores it there (§6.2). */
  broadcasterUserId?: string
  content: string
  type?: 'user' | 'bot'
  /** Renders the write as a native threaded reply rather than a loose @mention. */
  replyToMessageId?: string
}

export const MAX_CHAT_CHARS = 500

export class KickClient {
  private readonly apiBase: string
  private readonly getAccessToken: () => Promise<string>
  private readonly doFetch: typeof fetch

  constructor(opts: KickClientOptions) {
    this.apiBase = opts.apiBase
    this.getAccessToken = opts.getAccessToken
    this.doFetch = opts.fetchImpl ?? fetch
  }

  async currentUser(): Promise<{
    userId: string
    name: string
    email: string | null
    profilePicture: string | null
  }> {
    const json = await this.request<{
      data: { user_id: number | string; name: string; email?: string; profile_picture?: string }[]
    }>('GET', '/public/v1/users')
    const u = json.data?.[0]
    if (!u) throw new KickApiError(200, '/public/v1/users returned no user')
    return {
      userId: String(u.user_id),
      name: u.name,
      email: u.email ?? null,
      profilePicture: u.profile_picture ?? null,
    }
  }

  async currentChannel(): Promise<{
    broadcasterUserId: string
    slug: string
    channelId: string | null
  } | null> {
    const json = await this.request<{
      data: { broadcaster_user_id: number | string; slug: string; channel_id?: number | string }[]
    }>('GET', '/public/v1/channels')
    const c = json.data?.[0]
    if (!c) return null
    return {
      broadcasterUserId: String(c.broadcaster_user_id),
      slug: c.slug,
      channelId: c.channel_id === undefined ? null : String(c.channel_id),
    }
  }

  /**
   * POST /public/v1/chat — §6.2.
   *
   * Content over 500 characters is rejected by Kick, so it is truncated here
   * rather than thrown: a slightly clipped announcement beats none at all,
   * mid-stream.
   */
  async sendChat(input: SendChatInput): Promise<{ messageId: string | null }> {
    const body: Record<string, unknown> = {
      content: input.content.slice(0, MAX_CHAT_CHARS),
      type: input.type ?? 'user',
    }
    if (input.broadcasterUserId && (input.type ?? 'user') === 'user') {
      body.broadcaster_user_id = Number(input.broadcasterUserId)
    }
    if (input.replyToMessageId) body.reply_to_message_id = input.replyToMessageId

    const json = await this.request<{ data?: { message_id?: string; is_sent?: boolean } }>(
      'POST',
      '/public/v1/chat',
      body,
    )
    return { messageId: json.data?.message_id ?? null }
  }

  /** §6.3 — created when a session starts, deleted when it ends. Never standing. */
  async subscribe(input: {
    broadcasterUserId: string
    events: readonly KickEventType[]
    method?: 'webhook'
  }): Promise<{ subscriptionId: string; eventType: string }[]> {
    const json = await this.request<{
      data: { subscription_id?: string; id?: string; name?: string; error?: string }[]
    }>('POST', '/public/v1/events/subscriptions', {
      broadcaster_user_id: Number(input.broadcasterUserId),
      method: input.method ?? 'webhook',
      events: input.events.map((name) => ({ name, version: 1 })),
    })

    return (json.data ?? [])
      .filter((d) => !d.error && (d.subscription_id ?? d.id))
      .map((d) => ({ subscriptionId: (d.subscription_id ?? d.id)!, eventType: d.name ?? '' }))
  }

  async listSubscriptions(): Promise<
    { subscriptionId: string; eventType: string; broadcasterUserId: string }[]
  > {
    const json = await this.request<{
      data: {
        id: string
        event: string
        broadcaster_user_id?: number | string
        app_id?: string
      }[]
    }>('GET', '/public/v1/events/subscriptions')
    return (json.data ?? []).map((d) => ({
      subscriptionId: d.id,
      eventType: d.event,
      broadcasterUserId: String(d.broadcaster_user_id ?? ''),
    }))
  }

  /**
   * Kick wants the ids as a repeated `id=` parameter. The `id[]=` form its docs
   * suggest returns 400 "Invalid request" — verified against the live API.
   *
   * Getting this wrong is quietly expensive: the delete fails, the row gets
   * marked deleted locally anyway, and the subscription keeps delivering chat
   * for a channel nobody is playing on. That is the §6.3 quota leak exactly.
   */
  async unsubscribe(subscriptionIds: readonly string[]): Promise<void> {
    if (subscriptionIds.length === 0) return
    const qs = subscriptionIds.map((id) => `id=${encodeURIComponent(id)}`).join('&')
    await this.request('DELETE', `/public/v1/events/subscriptions?${qs}`)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getAccessToken()
    const res = await this.doFetch(new URL(path, this.apiBase), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (res.status === 429) {
      throw new KickRateLimitError(parseRetryAfter(res.headers.get('retry-after')))
    }
    if (!res.ok) {
      throw new KickApiError(res.status, await res.text().catch(() => ''), path)
    }
    if (res.status === 204) return {} as T

    const text = await res.text()
    return (text === '' ? {} : JSON.parse(text)) as T
  }
}

/** §15.5 — "429 -> respect Retry-After, exponential backoff, circuit break". */
export class KickRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Kick rate limited; retry in ${retryAfterMs}ms`)
    this.name = 'KickRateLimitError'
  }
}

export class KickApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path?: string,
  ) {
    super(`Kick API ${status} on ${path ?? 'request'}: ${body.slice(0, 300)}`)
    this.name = 'KickApiError'
  }

  /**
   * §15.6 — channels can be in slow / follower-only / sub-only mode and our
   * writes are subject to the same restrictions. Degrade to overlay-only
   * feedback rather than retrying into a wall.
   */
  get isChannelRestriction(): boolean {
    return this.status === 403 || this.status === 401
  }
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 5_000
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? 5_000 : Math.max(1_000, at - Date.now())
}
