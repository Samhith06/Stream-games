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
window.setGameTheme = (gameId) => {
  if (gameId === 'slot-tournament') document.documentElement.dataset.game = gameId
  else delete document.documentElement.dataset.game
}
