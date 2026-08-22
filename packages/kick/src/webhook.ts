/**
 * Webhook receiver primitives — §12, §10 step 1.
 *
 * "Signature verification, replay-window rejection on the timestamp header,
 * idempotency on message id. Return 200 fast and unconditionally on any valid
 * payload — a 500 triggers redelivery and burns quota twice."
 *
 * This module is pure verification and parsing. It never touches the database
 * and never decides what a message means.
 */

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto'
import { KICK_HEADER, type KickWebhookHeaders } from './types.js'

/** Reject anything older than this — a captured delivery can't be replayed later. */
export const REPLAY_WINDOW_MS = 5 * 60_000

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'bad_signature' | 'stale_timestamp' | 'no_public_key' }

export function readHeaders(
  headers: Record<string, string | string[] | undefined>,
): KickWebhookHeaders | null {
  const get = (name: string): string | null => {
    const v = headers[name] ?? headers[name.toLowerCase()]
    if (Array.isArray(v)) return v[0] ?? null
    return v ?? null
  }

  const messageId = get(KICK_HEADER.messageId)
  const signature = get(KICK_HEADER.signature)
  const timestamp = get(KICK_HEADER.timestamp)
  const eventType = get(KICK_HEADER.eventType)
  if (!messageId || !signature || !timestamp || !eventType) return null

  return {
    messageId,
    signature,
    timestamp,
    eventType,
    subscriptionId: get(KICK_HEADER.subscriptionId) ?? '',
    eventVersion: get(KICK_HEADER.eventVersion) ?? '1',
  }
}

/**
 * Kick signs `${messageId}.${timestamp}.${rawBody}` with RSA-SHA256 and
 * base64-encodes it. The raw body matters — verify before any JSON round trip,
 * because re-serialising changes the bytes.
 */
export function verifySignature(
  publicKey: KeyObject | null,
  headers: KickWebhookHeaders,
  rawBody: Buffer | string,
  opts: { now?: number; allowUnsigned?: boolean } = {},
): VerifyResult {
  const now = opts.now ?? Date.now()

  const sent = Date.parse(headers.timestamp)
  if (Number.isNaN(sent)) return { ok: false, reason: 'missing_headers' }
  if (Math.abs(now - sent) > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale_timestamp' }

  // Local replay testing only. Guarded by an env flag that must never be true
  // in production — an unsigned webhook endpoint is an open command injector.
  if (opts.allowUnsigned) return { ok: true }

  if (!publicKey) return { ok: false, reason: 'no_public_key' }

  const payload = Buffer.concat([
    Buffer.from(`${headers.messageId}.${headers.timestamp}.`),
    typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody,
  ])

  const verifier = createVerify('RSA-SHA256')
  verifier.update(payload)
  verifier.end()

  let valid = false
  try {
    valid = verifier.verify(publicKey, Buffer.from(headers.signature, 'base64'))
  } catch {
    valid = false
  }
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' }
}

/**
 * Kick publishes its signing key at /public/v1/public-key. Fetched once on boot
 * and cached; refetched only if verification starts failing, so a key rotation
 * doesn't require a deploy.
 */
export class PublicKeyProvider {
  private key: KeyObject | null = null
  private fetchedAt = 0
  private inflight: Promise<KeyObject | null> | null = null

  constructor(
    private readonly apiBase: string,
    pemOverride?: string,
  ) {
    if (pemOverride && pemOverride.trim() !== '') {
      this.key = createPublicKey(pemOverride.replace(/\\n/g, '\n'))
      this.fetchedAt = Date.now()
    }
  }

  async get(): Promise<KeyObject | null> {
    if (this.key) return this.key
    if (this.inflight) return this.inflight
    this.inflight = this.load().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Called after a signature failure, at most once a minute. */
  async invalidate(): Promise<void> {
    if (Date.now() - this.fetchedAt < 60_000) return
    this.key = null
  }

  private async load(): Promise<KeyObject | null> {
    try {
      const res = await fetch(new URL('/public/v1/public-key', this.apiBase))
      if (!res.ok) return null
      const json = (await res.json()) as { data?: { public_key?: string }; public_key?: string }
      const pem = json.data?.public_key ?? json.public_key
      if (!pem) return null
      this.key = createPublicKey(pem)
      this.fetchedAt = Date.now()
      return this.key
    } catch {
      return null
    }
  }
}
