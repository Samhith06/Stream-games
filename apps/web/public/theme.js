/**
 * Palette switching.
 *
 * Bonus Hunt and the dashboard shell are purple; tournaments are indigo. Both
 * palettes are defined in apps/web/styles/app.css and compiled into
 * /tailwind.css — the token names are identical in each, so nothing in the
 * markup changes. All that moves is one attribute on <html>.
 *
 * This file used to hold the whole Tailwind config and inject the palettes as a
 * <style> at runtime, because the pages loaded Tailwind from a CDN that
 * compiled in the browser. That is now a build step (`npm run build:css`), and
 * this is the only part that has to stay on the client.
 */

/** Call once a page knows which game it is showing. */
const THEMED = new Set(['slot-tournament', 'team-battles'])

window.setGameTheme = (gameId) => {
  if (THEMED.has(gameId)) document.documentElement.dataset.game = gameId
  else delete document.documentElement.dataset.game
}

/**
 * Team Battles lets a streamer run their own pair (§3), so the two team colours
 * are pushed in from the session config rather than baked into the stylesheet.
 * Only the two hues move — the neutral palette around them does not.
 */
window.setTeamColours = (a, b) => {
  const channels = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))
    if (!m) return null
    const n = parseInt(m[1], 16)
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
  }
  const ca = channels(a)
  const cb = channels(b)
  if (ca) document.documentElement.style.setProperty('--team-a', ca)
  if (cb) document.documentElement.style.setProperty('--team-b', cb)
}
