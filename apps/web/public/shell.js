/**
 * The dashboard chrome — side nav and top bar — rendered once and reused, so a
 * nav change lands on every page rather than in five copies.
 */

import { api, escapeHtml, elapsed } from './app.js'

const NAV = [
  { href: '/games', icon: 'casino', label: 'Game Catalog' },
  { href: '/session', icon: 'play_circle', label: 'Active Session', needsSession: true },
  { href: '/history', icon: 'history', label: 'History' },
  { href: '/settings', icon: 'settings', label: 'Settings' },
]

export async function mountShell({ active }) {
  let me = null
  try {
    me = await api('/api/me')
  } catch {
    return null // api() has already redirected to /login
  }

  const session = me.activeSession
  // Colour the chrome for whatever is live, so the nav doesn't fight the page.
  // Only ever sets; clearing is left to pages that know their own game.
  if (session) window.setGameTheme?.(session.gameId)
  document.body.insertAdjacentHTML('afterbegin', sidebar(me, session, active))

  if (session) startBanner(session)
  return me
}

function sidebar(me, session, active) {
  const items = NAV.map((item) => {
    const isActive = item.href === active
    const href = item.needsSession && session ? `${item.href}?id=${session.id}` : item.href
    const disabled = item.needsSession && !session

    return `
      <a href="${disabled ? '#' : href}"
         class="flex items-center gap-sm px-md py-sm rounded-lg transition-colors group ${
           isActive
             ? 'text-primary font-bold border-r-2 border-primary bg-surface-container-high/50'
             : disabled
               ? 'text-on-surface-variant/30 cursor-not-allowed'
               : 'text-on-surface-variant font-medium hover:bg-surface-container-high'
         }"
         ${disabled ? 'onclick="event.preventDefault()"' : ''}>
        <span class="material-symbols-outlined"${isActive ? ` style="font-variation-settings:'FILL' 1"` : ''}>${item.icon}</span>
        <span>${item.label}</span>
        ${item.needsSession && session ? '<span class="ml-auto w-2 h-2 rounded-full bg-win live-dot"></span>' : ''}
      </a>`
  }).join('')

  return `
  <aside class="h-screen w-64 fixed left-0 top-0 bg-surface-container border-r border-outline-variant flex flex-col p-md z-50">
    <div class="mb-xl flex flex-col gap-xs pt-sm px-xs">
      <h1 class="font-display-lg-mobile text-display-lg-mobile font-extrabold text-primary tracking-tight">StreamArena</h1>
      <span class="text-on-surface-variant font-data-mono text-[10px] uppercase tracking-widest">Elite Underground</span>
    </div>

    <a href="/games" class="mb-lg w-full bg-primary text-on-primary font-body-lg font-bold py-sm px-md rounded-lg
       flex items-center justify-center gap-sm transition-all hover:shadow-[0_0_15px_rgb(var(--primary)/0.4)] hover:brightness-110">
      <span class="material-symbols-outlined text-[20px]" style="font-variation-settings:'FILL' 1">videocam</span>
      ${session ? 'Back to session' : 'Start a game'}
    </a>

    <nav class="flex-1 flex flex-col gap-base">${items}</nav>

    ${
      me.isAdmin
        ? `<a href="/admin" class="flex items-center gap-sm px-md py-sm rounded-lg text-on-surface-variant
             hover:bg-surface-container-high transition-colors text-[14px]">
             <span class="material-symbols-outlined text-[20px]">admin_panel_settings</span> Admin Panel
           </a>`
        : ''
    }

    <div class="bg-surface-container-low rounded-xl p-sm flex items-center gap-sm border border-outline-variant/30 mt-md">
      <div class="relative">
        ${
          me.user.avatarUrl
            ? `<img src="${escapeHtml(me.user.avatarUrl)}" class="w-10 h-10 rounded-full border border-primary/30 object-cover" alt="">`
            : `<div class="w-10 h-10 rounded-full bg-surface-variant border border-primary/30 flex items-center justify-center
                 font-bold text-primary">${escapeHtml(me.user.displayName.slice(0, 2).toUpperCase())}</div>`
        }
        <div class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ${
          me.kickConnected ? 'bg-win' : 'bg-error'
        } border-2 border-surface-container-low live-dot"></div>
      </div>
      <div class="flex flex-col flex-1 min-w-0">
        <span class="font-body-md font-bold text-on-surface truncate">${escapeHtml(me.user.displayName)}</span>
        <span class="font-data-mono text-on-surface-variant text-[11px]">
          Kick <span class="${me.kickConnected ? 'text-win' : 'text-error'}">${
            me.kickConnected ? 'Connected' : 'Disconnected'
          }</span>
        </span>
      </div>
    </div>
  </aside>`
}

/** The live-session banner, with an elapsed clock that keeps ticking. */
function startBanner(session) {
  const main = document.querySelector('main')
  if (!main) return

  main.insertAdjacentHTML(
    'afterbegin',
    `<div class="sticky top-0 z-40 bg-surface/60 backdrop-blur-xl border-b border-outline-variant
                shadow-md shadow-primary/5 p-sm px-lg flex items-center justify-between">
      <div class="flex items-center gap-md">
        <div class="flex items-center gap-xs bg-win/10 text-win px-xs py-1 rounded border border-win/30">
          <div class="w-2 h-2 rounded-full bg-win live-dot"></div>
          <span class="font-data-mono text-[12px] font-bold tracking-widest uppercase">Live Session</span>
        </div>
        <h2 class="font-body-lg font-bold text-on-surface">${escapeHtml(gameName(session.gameId))}</h2>
        <div class="w-px h-4 bg-outline-variant"></div>
        <div class="flex flex-col">
          <span class="font-label-caps text-on-surface-variant uppercase text-[10px]">Elapsed</span>
          <span class="font-data-mono text-data-mono text-on-surface" id="shell-elapsed">—</span>
        </div>
        <div class="flex flex-col">
          <span class="font-label-caps text-on-surface-variant uppercase text-[10px]">Phase</span>
          <span class="font-data-mono text-data-mono text-primary capitalize">${escapeHtml(session.phase ?? '—')}</span>
        </div>
      </div>
      <a href="/session?id=${session.id}"
         class="bg-transparent border border-secondary text-secondary hover:bg-secondary/10 px-md py-xs rounded-lg
                font-body-md font-bold transition-colors flex items-center gap-xs">
        Return to session <span class="material-symbols-outlined text-[18px]">arrow_forward</span>
      </a>
    </div>`,
  )

  const tick = () => {
    const el = document.getElementById('shell-elapsed')
    if (el) el.textContent = elapsed(session.startedAt)
  }
  tick()
  setInterval(tick, 1000)
}

export const gameName = (id) =>
  ({ 'bonus-hunt': 'Bonus Hunt', 'slot-tournament': 'Slot Tournament' })[id] ?? id

/** Every dashboard page shares the same head. */
export function pageHead(title) {
  document.title = `${title} · StreamArena`
}
