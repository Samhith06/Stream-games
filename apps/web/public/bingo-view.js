/**
 * Slot Bingo's board and line rail, for the dashboard.
 *
 * Its own module because these are the two genuinely new views in the product —
 * a grid and a ranked list of lines — and session.html was already long enough
 * that adding them inline would bury the parts that are shared between games.
 *
 * Pure rendering: every function takes the projected state and returns HTML.
 */

import { escapeHtml, multiplier, slotTile } from './app.js'

/**
 * The board.
 *
 * A playable square is a button, because the streamer plays out of order often
 * enough — a viewer who just subbed, or to build a moment — that hunting for
 * that control elsewhere would cost more than it saves. §6 requires it to be
 * badged when they do.
 */
export function bingoBoard(state, { manualPick = true } = {}) {
  const squares = state.squares ?? []
  const size = state.size ?? 5

  return `
  <div class="bg-surface-container rounded-xl border border-outline-variant p-md">
    <div class="flex justify-between items-center mb-md">
      <h3 class="font-headline-md text-[18px] font-bold">Board</h3>
      ${
        state.currentSquareId
          ? `<span class="font-label-caps text-label-caps uppercase text-primary bg-primary/15
                         border border-primary/40 px-sm py-xs rounded">Armed · ${escapeHtml(state.currentSquareId)}</span>`
          : ''
      }
    </div>
    <div class="grid gap-1 aspect-square" style="grid-template-columns:repeat(${size},minmax(0,1fr))">
      ${squares.map((square) => cell(square, state, manualPick)).join('')}
    </div>
  </div>`
}

function cell(square, state, manualPick) {
  const armed = square.id === state.currentSquareId
  const playable =
    manualPick &&
    square.owner !== 'open' &&
    square.status !== 'settled' &&
    state.phase !== 'complete'

  // Colour is the whole language of this board, so it comes straight off the
  // tier the reducer settled on rather than being re-derived from a multiplier.
  const skin = armed
    ? 'border-primary bg-primary/10 ring-2 ring-primary/50'
    : square.tier === 'gold'
      ? 'border-gold bg-gold/10'
      : square.tier === 'green'
        ? 'border-win/60 bg-win/5'
        : square.tier === 'red'
          ? 'border-outline-variant bg-surface-container-low opacity-60'
          : square.owner === 'open'
            ? 'border-dashed border-outline-variant/60 bg-surface-container-low/40'
            : 'border-outline-variant/40 bg-surface-container-low'

  const tag = playable ? 'button' : 'div'
  const attrs = playable ? `data-pickmanual="${escapeHtml(square.id)}"` : ''

  return `
  <${tag} ${attrs}
    class="relative rounded-lg border ${skin} flex flex-col items-center justify-center overflow-hidden
           ${playable ? 'hover:border-primary transition-colors cursor-pointer' : ''}">
    <span class="absolute top-0.5 left-1 font-label-caps text-[9px] text-on-surface-variant/60 z-10">
      ${escapeHtml(square.id)}</span>
    ${square.manualPick ? '<span class="absolute top-0.5 right-1 text-[9px] text-primary z-10" title="Streamer pick">*</span>' : ''}
    ${cellBody(square)}
  </${tag}>`
}

function cellBody(square) {
  if (square.owner === 'open') {
    return `
      <span class="material-symbols-outlined text-outline-variant text-[20px]">lock</span>
      ${
        square.unlockAfterPick !== null && square.unlockAfterPick !== undefined
          ? `<span class="font-label-caps text-[9px] text-on-surface-variant/70 text-center leading-tight mt-1">
               OPENS<br>PICK ${square.unlockAfterPick}</span>`
          : ''
      }`
  }

  if (square.status === 'settled') {
    const colour =
      square.tier === 'gold'
        ? 'text-gold'
        : square.tier === 'green'
          ? 'text-win'
          : 'text-on-surface-variant'
    return `
      <span class="font-data-mono font-bold text-[15px] ${colour}">${multiplier(square.multiplier)}</span>
      <span class="text-[10px] text-on-surface-variant truncate max-w-full px-1">
        ${escapeHtml(square.username ?? 'house')}</span>`
  }

  return `
    ${slotTile(square.slotName, square.thumbnail, 'w-7 h-7 rounded object-cover text-[10px] mb-0.5')}
    <span class="text-[10px] text-on-surface truncate max-w-full px-1">
      ${escapeHtml(square.username ?? 'house')}</span>
    <span class="text-[9px] text-on-surface-variant/60 truncate max-w-full px-1">
      ${escapeHtml(square.slotName ?? '')}</span>`
}

/**
 * The line rail — §7.
 *
 * Sorted by how close a line is rather than by id, because one-away is the
 * money state and burying it under "row 1, row 2, row 3" would waste it. Dead
 * lines collapse rather than disappearing: the streamer needs to see what the
 * board cost, not only what is left.
 */
export function lineRail(state) {
  const rank = { oneAway: 0, complete: 1, open: 2, dead: 3 }
  const sorted = [...(state.lines ?? [])].sort(
    (a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.totalMultiplier - a.totalMultiplier,
  )

  return `
  <div class="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
    <div class="p-md border-b border-outline-variant bg-surface-container-high flex justify-between items-center">
      <h3 class="font-headline-md text-[18px] font-bold">Lines</h3>
      <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">
        ${state.linesAlive ?? 0} of ${state.linesTotal ?? 0} alive</span>
    </div>
    <div class="p-sm flex flex-col gap-1 max-h-[520px] overflow-y-auto">
      ${sorted.map((line) => lineRow(line, state)).join('')}
    </div>
  </div>`
}

function lineRow(line, state) {
  const dead = line.state === 'dead'
  const skin =
    line.state === 'complete'
      ? 'border-win bg-win/10'
      : line.state === 'oneAway'
        ? 'border-gold bg-gold/5'
        : dead
          ? 'border-outline-variant/20 opacity-50'
          : 'border-outline-variant/40'

  const byId = new Map((state.squares ?? []).map((s) => [s.id, s]))

  // A miniature of the line, in the same colours as the board — so the rail and
  // the grid can be read against each other without translating.
  const pips = line.squareIds
    .map((id) => {
      const square = byId.get(id)
      const colour =
        id === state.currentSquareId
          ? 'bg-surface-bright border border-primary'
          : square?.tier === 'gold'
            ? 'bg-gold'
            : square?.tier === 'green'
              ? 'bg-win'
              : square?.tier === 'red'
                ? 'bg-surface-dim border border-loss/50'
                : 'bg-surface-dim border border-outline-variant/30'
      return `<span class="w-3.5 h-3.5 rounded-sm ${colour}" title="${escapeHtml(id)}"></span>`
    })
    .join('')

  const missing = line.squareIds.filter((id) => byId.get(id)?.status !== 'settled')

  const right =
    line.state === 'oneAway'
      ? `<div class="font-label-caps text-label-caps uppercase text-gold">1 away</div>
         <div class="font-data-mono text-[12px] text-on-surface-variant">Need ${escapeHtml(missing[0] ?? '')}</div>`
      : dead
        ? '<div class="font-label-caps text-label-caps uppercase text-outline">Dead</div>'
        : `<div class="font-label-caps text-label-caps uppercase text-on-surface-variant">Total</div>
           <div class="font-data-mono text-win">${multiplier(line.totalMultiplier)}</div>`

  return `
  <div class="rounded-lg border ${skin} p-sm flex items-center justify-between gap-md">
    <div class="min-w-0">
      <div class="font-label-caps text-label-caps uppercase mb-1 ${
        line.state === 'oneAway' ? 'text-gold' : 'text-on-surface-variant'
      }">${escapeHtml(line.label)}</div>
      <div class="flex gap-1">${pips}</div>
    </div>
    <div class="text-right shrink-0">${right}</div>
  </div>`
}

/** The joining panel, before the draw runs. */
export function bingoJoining(state) {
  const open = (state.squares ?? []).filter((s) => s.owner === 'open').length

  return `
  <div class="bg-surface-container rounded-xl border border-outline-variant p-lg mb-lg
              flex flex-wrap items-center justify-between gap-md">
    <div>
      <div class="font-headline-md text-headline-md">${state.entrantCount ?? 0} entrants</div>
      <p class="text-on-surface-variant mt-base">
        Viewers type <span class="font-data-mono text-primary">!join &lt;slot&gt;</span> to claim a square.
        ${open > 0 ? `${open} held back to open later.` : ''}
      </p>
    </div>
    ${
      state.joinWindowEndsAt
        ? `<div class="text-right">
             <div class="font-label-caps text-label-caps text-on-surface-variant uppercase">Closes in</div>
             <div class="font-data-mono text-[28px] text-primary" id="timer"
                  data-ends="${state.joinWindowEndsAt}">—</div>
           </div>`
        : ''
    }
  </div>`
}

/** The result screen — which line won, and how it was decided (§8). */
export function bingoResult(state) {
  const bingo = (state.bingoLines ?? []).length > 0
  const lines = state.lines ?? []
  const winning = lines.find((l) => l.id === state.winningLine)

  const how = {
    bingo: 'Completed line',
    bestLine: 'Highest combined multiplier',
    payout: 'Tied on multiplier — decided on combined payout',
    greenCount: 'Tied on payout — decided on green count',
    cost: 'Tied on greens — decided on lower combined cost',
    coinflip: 'Tied throughout — decided on a seeded coin flip',
    settledEarly: 'Settled early — best fully-played line',
    capped: 'Stopped on a cap — best line',
  }[state.decidedBy] ?? ''

  return `
  <div class="bg-surface-container rounded-xl border ${bingo ? 'border-gold' : 'border-primary/40'}
              p-xl mb-lg text-center relative overflow-hidden">
    <div class="absolute top-0 left-0 w-full h-1 ${bingo ? 'bg-gold' : 'bg-primary'}"></div>
    <h2 class="font-display-lg text-display-lg ${bingo ? 'text-gold' : 'text-primary'} mb-xs">
      ${bingo ? 'BINGO' : 'BEST LINE'}
    </h2>
    <p class="font-headline-md text-headline-md text-on-surface mb-sm">
      ${escapeHtml(winning?.label ?? '—')}
      ${winning ? `<span class="text-on-surface-variant"> · ${multiplier(winning.totalMultiplier)} combined</span>` : ''}
    </p>
    ${
      // §8 — "always state on screen how it was decided. An unexplained winning
      // line reads as broken software."
      how ? `<p class="text-on-surface-variant text-sm mb-lg">${escapeHtml(how)}</p>` : ''
    }
    <div class="flex flex-wrap justify-center gap-sm">
      ${(state.winners ?? [])
        .map(
          (w) => `
        <span class="bg-surface-container-high border border-outline-variant/40 rounded-full
                     px-md py-xs flex items-center gap-xs">
          <span class="font-bold">${escapeHtml(w.username)}</span>
          <span class="text-on-surface-variant text-sm">${escapeHtml(w.slotName ?? '')}</span>
        </span>`,
        )
        .join('')}
    </div>
    ${
      (state.winners ?? []).length === 0
        ? '<p class="text-on-surface-variant">No viewer squares on the winning line.</p>'
        : ''
    }
  </div>`
}

/**
 * Who is on the board, and what they called — the roster.
 *
 * The board answers "what is on C3". This answers "where is rosie_x", which is
 * the question a streamer actually gets asked in chat, and answers it without
 * hunting a 5×5 grid for a name. It also doubles as the thing to read aloud
 * after the draw: twenty-five names and slots in one column.
 *
 * **Ordered by the board, never by the pick order.** The committed order is
 * secret — §5.1 publishes a hash of it precisely so nobody can claim a square
 * was played on purpose, and the setup screen promises "nobody sees it in
 * advance, including you". Sorting this list by `pickOrder` would be the most
 * natural thing in the world and would quietly hand the streamer the one fact
 * the whole commitment exists to withhold. Reading order it is.
 */
export function participantList(state) {
  const squares = state.squares ?? []
  const seated = squares.filter((s) => s.username)
  const waiting = state.standby ?? []

  return `
  <div class="bg-surface-container rounded-xl border border-outline-variant p-md">
    <div class="flex justify-between items-baseline mb-md gap-sm">
      <h3 class="font-headline-md text-[18px] font-bold">Participants</h3>
      <span class="font-data-mono text-[11px] text-on-surface-variant">
        ${seated.length} on the board${waiting.length > 0 ? ` · ${waiting.length} waiting` : ''}
      </span>
    </div>

    <div class="flex flex-col gap-1 max-h-[420px] overflow-y-auto pr-1">
      ${squares.map(rosterRow).join('')}
    </div>

    ${
      waiting.length > 0
        ? `<details class="mt-md border-t border-outline-variant pt-md">
             <summary class="cursor-pointer list-none flex items-center gap-sm
                             font-label-caps text-label-caps uppercase text-on-surface-variant">
               <span class="material-symbols-outlined text-[18px]">hourglass_empty</span>
               ${waiting.length} waiting for a square
             </summary>
             <div class="flex flex-col gap-1 mt-sm max-h-[260px] overflow-y-auto pr-1">
               ${waiting.map(waitingRow).join('')}
             </div>
           </details>`
        : ''
    }
  </div>`
}

/** One square's seat: who holds it, what they called, and how it went. */
function rosterRow(square) {
  const empty = !square.username

  return `
  <div class="flex items-center gap-sm px-sm py-1 rounded ${empty ? 'opacity-50' : 'hover:bg-surface-container-high'}">
    <span class="font-data-mono text-[12px] text-on-surface-variant w-8 shrink-0">${escapeHtml(square.id)}</span>
    <span class="flex-1 min-w-0 truncate">
      ${
        empty
          ? `<span class="text-on-surface-variant text-sm">${seatLabel(square)}</span>`
          : `<span class="font-bold text-sm">${escapeHtml(square.username)}</span>
             <span class="text-on-surface-variant text-sm"> · ${escapeHtml(square.slotName ?? 'no slot yet')}</span>`
      }
    </span>
    ${rosterState(square)}
  </div>`
}

/** What an empty square is waiting for — the three reasons differ on screen. */
function seatLabel(square) {
  if (square.owner === 'free') return 'Free centre'
  if (square.reopened) return `Reopened${square.lastBurned ? ` · burned @${escapeHtml(square.lastBurned)}` : ''}`
  if (square.unlockAfterPick !== null && square.unlockAfterPick !== undefined) {
    return `Opens after pick ${square.unlockAfterPick}`
  }
  return 'House'
}

/** The right-hand chip: a result once there is one, otherwise what it is waiting on. */
function rosterState(square) {
  if (square.status === 'settled' && square.tier) {
    const tone =
      square.tier === 'gold' ? 'text-gold' : square.tier === 'green' ? 'text-win' : 'text-loss'
    return `<span class="font-data-mono text-[12px] ${tone} shrink-0">
        ${square.multiplier === null || square.multiplier === undefined ? square.tier.toUpperCase() : multiplier(square.multiplier)}
      </span>`
  }

  // §6.5.3 — the cursed-square counter, where it is useful rather than decorative.
  if (square.burnCount > 0) {
    return `<span class="font-data-mono text-[11px] text-loss shrink-0">${square.burnCount} burned</span>`
  }

  return '<span class="font-data-mono text-[11px] text-on-surface-variant/50 shrink-0">—</span>'
}

/**
 * Someone in the queue. A re-entrant who lost their slot to `burnPlayedSlots`
 * is waiting on their own `!join` rather than on the streamer, and saying so
 * is the difference between a queue and a list of names.
 */
function waitingRow(member) {
  return `
  <div class="flex items-center gap-sm px-sm py-1 rounded hover:bg-surface-container-high">
    <span class="flex-1 min-w-0 truncate text-sm">
      <span class="font-bold">${escapeHtml(member.username)}</span>
      ${
        member.slotName
          ? `<span class="text-on-surface-variant"> · ${escapeHtml(member.slotName)}</span>`
          : '<span class="text-on-surface-variant/60"> · waiting on their !join</span>'
      }
    </span>
  </div>`
}
