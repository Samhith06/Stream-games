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
