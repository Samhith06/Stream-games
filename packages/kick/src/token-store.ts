/**
 * Encrypted token storage with refresh-ahead — §12.
 *
 * Callers ask for a client, not a token. That way there is exactly one place
 * that decrypts, one place that refreshes, and no path where a plaintext token
 * is handed around and later logged by accident.
 */

import type { Repos } from '@streamarena/db'
import { KickAuth, KickAuthError, needsRefresh, type KickTokenSet } from './auth.js'
import { KickClient } from './client.js'
import type { TokenCipher } from './crypto.js'

export class TokenStore {
  /** Coalesces concurrent refreshes for one user into a single round trip. */
  private readonly inflight = new Map<string, Promise<string>>()

  constructor(
    private readonly repos: Repos,
    private readonly cipher: TokenCipher,
    private readonly auth: KickAuth,
    private readonly apiBase: string,
  ) {}

  async save(userId: string, tokens: KickTokenSet): Promise<void> {
    await this.repos.tokens.put({
      userId,
      accessToken: this.cipher.encrypt(tokens.accessToken),
      refreshToken: this.cipher.encrypt(tokens.refreshToken),
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
    })
  }

  /** A valid access token, refreshed first if it's inside the margin. */
  async accessToken(userId: string): Promise<string> {
    const existing = this.inflight.get(userId)
    if (existing) return existing

    const promise = this.resolve(userId).finally(() => this.inflight.delete(userId))
    this.inflight.set(userId, promise)
    return promise
  }

  private async resolve(userId: string): Promise<string> {
    const row = await this.repos.tokens.byUserId(userId)
    if (!row) throw new MissingTokenError(userId)

    if (!needsRefresh(row.expiresAt)) {
      return this.cipher.decrypt(row.accessToken)
    }

    try {
      const refreshed = await this.auth.refresh(this.cipher.decrypt(row.refreshToken))
      await this.save(userId, refreshed)
      return refreshed.accessToken
    } catch (err) {
      // A rejected refresh means the streamer revoked us, or the grant expired.
      // Drop the row so the dashboard shows "reconnect Kick" instead of retrying
      // a dead token on every chat write for the rest of the session.
      if (err instanceof KickAuthError && err.status >= 400 && err.status < 500) {
        await this.repos.tokens.remove(userId)
        throw new TokenRevokedError(userId)
      }
      throw err
    }
  }

  /** The only way to obtain a Kick client anywhere in the platform. */
  client(userId: string): KickClient {
    return new KickClient({
      apiBase: this.apiBase,
      getAccessToken: () => this.accessToken(userId),
    })
  }

  async hasTokens(userId: string): Promise<boolean> {
    return (await this.repos.tokens.byUserId(userId)) !== null
  }

  async scopes(userId: string): Promise<string[]> {
    return (await this.repos.tokens.byUserId(userId))?.scopes ?? []
  }

  async disconnect(userId: string): Promise<void> {
    const row = await this.repos.tokens.byUserId(userId)
    if (!row) return
    try {
      await this.auth.revoke(this.cipher.decrypt(row.refreshToken), 'refresh_token')
    } catch {
      // Best effort — the local row is what matters for our behaviour.
    }
    await this.repos.tokens.remove(userId)
  }
}

export class MissingTokenError extends Error {
  constructor(readonly userId: string) {
    super(`No Kick tokens stored for user ${userId}`)
    this.name = 'MissingTokenError'
  }
}

export class TokenRevokedError extends Error {
  constructor(readonly userId: string) {
    super(`Kick access for user ${userId} was revoked or expired — reconnect required`)
    this.name = 'TokenRevokedError'
  }
}
