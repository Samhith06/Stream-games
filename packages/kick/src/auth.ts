/**
 * Kick OAuth 2.1 + PKCE — §6, §12.
 *
 * Scopes required: user:read, channel:read, chat:write, events:subscribe.
 * Nothing outside this package builds a Kick URL or handles a Kick token.
 */

import { createHash, randomBytes } from 'node:crypto'

export const KICK_SCOPES = ['user:read', 'channel:read', 'chat:write', 'events:subscribe'] as const

export interface KickAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  idBase: string
  scopes?: readonly string[]
}

export interface PkcePair {
  verifier: string
  challenge: string
}

/** PKCE S256. The verifier is held server-side against the `state` value. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createState(): string {
  return randomBytes(24).toString('base64url')
}

export interface KickTokenSet {
  accessToken: string
  refreshToken: string
  /** Absolute expiry, computed from `expires_in` at exchange time. */
  expiresAt: Date
  scopes: string[]
  tokenType: string
}

export class KickAuth {
  constructor(private readonly config: KickAuthConfig) {}

  private get scopes(): readonly string[] {
    return this.config.scopes ?? KICK_SCOPES
  }

  authorizeUrl(opts: { state: string; challenge: string }): string {
    const url = new URL('/oauth/authorize', this.config.idBase)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', this.config.redirectUri)
    url.searchParams.set('scope', this.scopes.join(' '))
    url.searchParams.set('code_challenge', opts.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', opts.state)
    return url.toString()
  }

  async exchangeCode(code: string, verifier: string): Promise<KickTokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier,
    })
  }

  /**
   * Refresh ahead of the 3600s expiry (§12) — callers use `needsRefresh` rather
   * than waiting for a 401, because discovering an expired token mid-session
   * means a dropped chat write on stream.
   */
  async refresh(refreshToken: string): Promise<KickTokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  async revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void> {
    const url = new URL('/oauth/revoke', this.config.idBase)
    url.searchParams.set('token', token)
    url.searchParams.set('token_hint_type', hint)
    await fetch(url, { method: 'POST' })
  }

  private async tokenRequest(extra: Record<string, string>): Promise<KickTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      ...extra,
    })

    const res = await fetch(new URL('/oauth/token', this.config.idBase), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!res.ok) {
      throw new KickAuthError(res.status, await res.text().catch(() => ''))
    }

    const json = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      scope?: string
      token_type?: string
    }

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scopes: (json.scope ?? this.scopes.join(' ')).split(/[\s,]+/).filter(Boolean),
      tokenType: json.token_type ?? 'Bearer',
    }
  }
}

/** Refresh this far before actual expiry. */
export const REFRESH_MARGIN_MS = 5 * 60_000

export function needsRefresh(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() - now <= REFRESH_MARGIN_MS
}

export class KickAuthError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Kick OAuth failed with ${status}: ${body.slice(0, 300)}`)
    this.name = 'KickAuthError'
  }
}
