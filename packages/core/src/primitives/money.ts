/**
 * Amount parsing for `!guess` and streamer number entry — §13.
 *
 * "strip currency symbols, commas, spaces; expand k/K (!guess 6.5k -> 6500).
 * Reject above a sanity ceiling, default 100x starting balance."
 */

export type ParseAmountError =
  | 'empty'
  | 'not_a_number'
  | 'negative'
  | 'above_ceiling'

export type ParseAmountResult =
  | { ok: true; value: number }
  | { ok: false; error: ParseAmountError }

const CURRENCY_CHARS = /[€$£¥₹\s,_]/g

export interface ParseAmountOptions {
  /** Reject anything above this. Omit for no ceiling. */
  ceiling?: number
  /** Allow zero. Default true — a €0 payout is valid and common. */
  allowZero?: boolean
}

export function parseAmount(input: string, opts: ParseAmountOptions = {}): ParseAmountResult {
  const { ceiling, allowZero = true } = opts

  let s = (input ?? '').trim().toLowerCase()
  if (s === '') return { ok: false, error: 'empty' }

  s = s.replace(CURRENCY_CHARS, '')

  // Accept a trailing k/m multiplier: 6.5k -> 6500, 1.2m -> 1_200_000.
  let multiplier = 1
  const suffix = s.at(-1)
  if (suffix === 'k') {
    multiplier = 1_000
    s = s.slice(0, -1)
  } else if (suffix === 'm') {
    multiplier = 1_000_000
    s = s.slice(0, -1)
  }

  // A single comma already stripped above; a lone dot is the decimal point.
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    return { ok: false, error: 'not_a_number' }
  }

  const n = Number.parseFloat(s) * multiplier
  if (!Number.isFinite(n)) return { ok: false, error: 'not_a_number' }
  if (n < 0) return { ok: false, error: 'negative' }
  if (n === 0 && !allowZero) return { ok: false, error: 'negative' }
  if (ceiling !== undefined && n > ceiling) return { ok: false, error: 'above_ceiling' }

  return { ok: true, value: round2(n) }
}

/** Money is held as a number of currency units, rounded to cents on every op. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Whole amounts drop the decimals — "€1,720" reads on stream where "€1,720.00"
 * is just noise. Fractional amounts keep both places so cents never round away
 * silently.
 */
export function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€'
  const abs = Math.abs(amount)
  const body = Number.isInteger(abs)
    ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${amount < 0 ? '-' : ''}${symbol}${body}`
}

export function formatSigned(amount: number, currency: string): string {
  return `${amount >= 0 ? '+' : ''}${formatMoney(amount, currency)}`
}

/** Multipliers render as 4.25x — two decimals, no thousands separator. */
export function formatMultiplier(x: number): string {
  return `${x.toFixed(2)}x`
}
