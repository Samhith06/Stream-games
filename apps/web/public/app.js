/**
 * Shared client for every dashboard page.
 *
 * Deliberately dependency-free and served straight from the API origin, so the
 * cookie set by the OAuth callback is same-origin and there is no second build
 * pipeline to keep in step with the backend.
 */

// ─── API ────────────────────────────────────────────────────────────────────

export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    ...(options.body && typeof options.body !== 'string'
      ? { body: JSON.stringify(options.body) }
      : {}),
  })

  if (res.status === 401) {
    // Not signed in. Every page except the login screen needs a session.
    if (!location.pathname.startsWith('/login')) location.href = '/login'
    throw new Error('unauthorized')
  }

  const text = await res.text()
  const json = text === '' ? {} : JSON.parse(text)

  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `Request failed (${res.status})`)
    err.code = json?.error?.code
    err.details = json?.error?.details
    throw err
  }
  return json
}

/** Every dashboard action goes through one endpoint (§10). */
export const control = (sessionId, action, payload = {}) =>
  api(`/api/sessions/${sessionId}/control`, { method: 'POST', body: { action, payload } })

// ─── Live state ─────────────────────────────────────────────────────────────

/**
 * Connects to a session socket and keeps a merged view of its state.
 *
 * §19 — the server sends a full snapshot on connect, then patches. Gap
 * detection runs on `frame`, NOT `seq`: plenty of events change nothing the
 * overlay can see (a slot lookup that fails to match moves `seq` and emits no
 * patch), so watching `seq` would resync constantly and defeat patching.
 */
export function connect({ url, onState, onCue, onStatus }) {
  let socket
  let state = {}
  let lastFrame = -1
  let retry = 0
  let closed = false
  let heartbeat

  const open = () => {
    socket = new WebSocket(url)

    socket.onopen = () => {
      retry = 0
      onStatus?.('connected')
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' }))
      }, 20_000)
    }

    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data)

      if (frame.t === 'snapshot') {
        lastFrame = frame.frame
        state = frame.state
        onState?.(state, frame)
        return
      }

      if (frame.t === 'patch') {
        if (lastFrame >= 0 && frame.frame > lastFrame + 1) {
          // A frame went missing. One state dump is cheaper than guessing.
          socket.send(JSON.stringify({ t: 'resync', haveFrame: lastFrame }))
          return
        }
        lastFrame = Math.max(lastFrame, frame.frame)

        // Ephemeral cues aren't state — they drive animations and must not be
        // merged, or the overlay would replay the last flash on every resync.
        const cues = {}
        for (const key of ['flash', 'matchResult', 'drawReveal', 'inputError']) {
          if (frame.patch[key] !== undefined) {
            cues[key] = frame.patch[key]
            delete frame.patch[key]
          }
        }

        state = { ...state, ...frame.patch }
        for (const [key, value] of Object.entries(state)) {
          if (value === null) delete state[key]
        }

        onState?.(state, frame)
        for (const [kind, payload] of Object.entries(cues)) onCue?.(kind, payload)
        return
      }

      if (frame.t === 'ended') {
        onStatus?.('ended')
        closed = true
        socket.close()
      }
    }

    socket.onclose = () => {
      clearInterval(heartbeat)
      if (closed) return
      onStatus?.('reconnecting')
      // OBS browser sources drop constantly, so reconnect is the normal case,
      // not the exception. Back off but stay responsive.
      retry = Math.min(retry + 1, 6)
      setTimeout(open, Math.min(500 * 2 ** retry, 10_000))
    }

    socket.onerror = () => socket.close()
  }

  open()
  return {
    stop() {
      closed = true
      clearInterval(heartbeat)
      socket?.close()
    },
    get state() {
      return state
    },
  }
}

// ─── formatting ─────────────────────────────────────────────────────────────

const SYMBOL = { EUR: '€', USD: '$', GBP: '£' }

/** Whole amounts drop the decimals — "€1,720" reads; "€1,720.00" is noise. */
export function money(amount, currency = 'EUR') {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '—'
  const symbol = SYMBOL[currency] ?? '€'
  const abs = Math.abs(amount)
  const body = Number.isInteger(abs)
    ? abs.toLocaleString('en-US')
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${amount < 0 ? '-' : ''}${symbol}${body}`
}

export const signed = (amount, currency) =>
  `${amount >= 0 ? '+' : ''}${money(amount, currency)}`

export const multiplier = (x) => (x === null || x === undefined ? '—' : `${x.toFixed(2)}x`)

export function countdown(endsAt) {
  if (!endsAt) return null
  const left = Math.max(0, endsAt - Date.now())
  const total = Math.ceil(left / 1000)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function elapsed(since) {
  if (!since) return '—'
  const total = Math.floor((Date.now() - new Date(since).getTime()) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

// ─── UI helpers ─────────────────────────────────────────────────────────────

/**
 * Stand-in artwork for a slot the catalog has no image for.
 *
 * The upstream catalog carries names, providers and RTP but no imagery, so most
 * slots would otherwise be an identical grey square. On stream that is worse
 * than it sounds: the queue becomes a column of blanks and a viewer cannot pick
 * their own request out of it at a glance.
 *
 * The colour is derived from the name, so a slot looks the same every hunt and
 * regulars start recognising them. Hue only — saturation and lightness are
 * fixed, which keeps every tile legible against the dark surface and stops the
 * generator producing something that fights the palette.
 */
export function slotArt(name) {
  const text = String(name ?? '').trim() || '?'

  // FNV-1a, same as the seeded RNG elsewhere: small, stable, well spread.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  // Connectors are skipped so "Fire in the Hole" reads FH rather than FI — but
  // only when something is left, or "Hand of Anubis" would lose its H.
  const CONNECTORS = new Set(['a', 'an', 'and', 'at', 'in', 'of', 'or', 'the', 'to', 'vs'])
  const words = text.split(/[\s:'-]+/).filter((word) => /[a-z0-9]/i.test(word))
  const meaningful = words.filter((word) => !CONNECTORS.has(word.toLowerCase()))

  const initials = (meaningful.length > 0 ? meaningful : words)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('')

  return { hue: hash % 360, initials: initials || text[0].toUpperCase() }
}

/** `slotArt` as a ready-made tile. `className` carries the size and shape. */
export function slotTile(name, thumbnail, className) {
  if (thumbnail) return `<img class="${className}" src="${escapeHtml(thumbnail)}" alt="">`

  const { hue, initials } = slotArt(name)
  return `<div class="${className}" style="
      background: linear-gradient(140deg, hsl(${hue} 52% 34%), hsl(${(hue + 40) % 360} 52% 22%));
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; letter-spacing: .02em; color: hsl(${hue} 70% 88%);
    ">${escapeHtml(initials)}</div>`
}

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts')
  if (!host) {
    host = document.createElement('div')
    host.id = 'toasts'
    host.className = 'fixed bottom-6 right-6 z-[100] flex flex-col gap-2 items-end'
    document.body.appendChild(host)
  }

  const colour =
    kind === 'error'
      ? 'border-error text-error'
      : kind === 'success'
        ? 'border-win text-win'
        : 'border-outline-variant text-on-surface'

  const el = document.createElement('div')
  el.className =
    `bg-surface-container border ${colour} rounded-lg px-4 py-3 shadow-xl ` +
    'font-body-md text-sm max-w-sm animate-[fadeIn_.15s_ease-out]'
  el.textContent = message
  host.appendChild(el)
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500)
}

/**
 * A confirmation the page draws itself, resolving true if the user goes ahead.
 *
 * Native confirm() is what this replaces: it is unstyled, it looks like a
 * browser malfunction next to the rest of the app, and some browsers suppress
 * it outright — which turns "are you sure?" into a destructive action that
 * happens with no prompt at all.
 */
export function confirmAction({ title, body, confirmLabel = 'Confirm', destructive = false }) {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    host.className =
      'fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-gutter'

    const accent = destructive ? 'bg-error text-on-error' : 'bg-primary text-on-primary'
    host.innerHTML = `
      <div class="bg-surface-container rounded-xl border border-outline-variant shadow-xl max-w-md w-full
                  p-xl relative overflow-hidden animate-[fadeIn_.15s_ease-out]">
        <div class="absolute top-0 left-0 w-full h-1 ${destructive ? 'bg-error' : 'bg-primary'}"></div>
        <h2 class="font-display-lg-mobile text-display-lg-mobile font-bold mb-sm">${escapeHtml(title)}</h2>
        <p class="text-on-surface-variant mb-lg">${escapeHtml(body)}</p>
        <div class="flex gap-md justify-end">
          <button data-no class="px-md py-sm rounded-lg font-bold text-on-surface-variant
            hover:bg-surface-variant transition-colors font-label-caps uppercase">Cancel</button>
          <button data-yes class="${accent} px-md py-sm rounded-lg font-bold font-label-caps uppercase">
            ${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`

    const close = (answer) => {
      host.remove()
      document.removeEventListener('keydown', onKey)
      resolve(answer)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close(false)
      if (e.key === 'Enter') close(true)
    }

    host.querySelector('[data-no]').onclick = () => close(false)
    host.querySelector('[data-yes]').onclick = () => close(true)
    // Clicking the backdrop cancels; clicking the card must not.
    host.onclick = (e) => { if (e.target === host) close(false) }
    document.addEventListener('keydown', onKey)

    document.body.appendChild(host)
    host.querySelector('[data-no]').focus()
  })
}

/** Wraps an action so a failure surfaces instead of vanishing into the console. */
export async function attempt(fn, { success } = {}) {
  try {
    const result = await fn()
    if (success) toast(success, 'success')
    return result
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'error')
    throw err
  }
}

export function requireSessionId() {
  const id = new URLSearchParams(location.search).get('id')
  if (!id) {
    location.href = '/games'
    throw new Error('no session id')
  }
  return id
}

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast(label, 'success')
  } catch {
    toast('Could not copy — select it manually', 'error')
  }
}
