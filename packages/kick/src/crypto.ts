/**
 * Token encryption at rest — §12.
 *
 * "Encrypt refresh tokens at rest. A leaked refresh token lets someone post as
 * the streamer; treat it like a password."
 *
 * AES-256-GCM from node:crypto rather than libsodium: same authenticated
 * encryption, no native dependency to build on a PaaS image. The key lives in
 * the platform secret store and never in the database.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const VERSION = 'v1'

export class TokenCipher {
  private readonly key: Buffer

  constructor(hexKey: string) {
    const key = Buffer.from(hexKey, 'hex')
    if (key.length !== 32) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY must be 32 bytes of hex (64 characters). ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      )
    }
    this.key = key
  }

  /** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, b64(iv), b64(tag), b64(ct)].join('.')
  }

  decrypt(payload: string): string {
    const parts = payload.split('.')
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Malformed encrypted token payload')
    }
    const iv = unb64(parts[1]!)
    const tag = unb64(parts[2]!)
    const ct = unb64(parts[3]!)
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('Malformed encrypted token payload')
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  }
}

const b64 = (b: Buffer) => b.toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url')

/** Constant-time compare for overlay tokens and signed cookies. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}
