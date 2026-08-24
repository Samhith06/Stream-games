/**
 * Team Battles' dashboard panels.
 *
 * Its own module for the same reason `bingo-view.js` is: these are views
 * nothing else in the product has — two opposed team columns, a coin-flip
 * control with a point of no return, and a swing figure that is the largest
 * thing on the page during buying.
 *
 * One rule runs through all of it, from §3: **no control wears a team colour.**
 * The two teams own violet and gold here; every button the streamer presses is
 * neutral. A "Run the flip" button tinted with one side's colour reads as the
 * streamer pressing for that side, whatever the code actually does.
 *
 * Pure rendering — every function takes projected state and returns HTML.
 */

import { escapeHtml, money, multiplier, slotTile } from './app.js'

/** Team A is violet, team B is gold. Fixed classes so Tailwind compiles them. */
const SKIN = {
  A: {
    text: 'text-team-a',
    border: 'border-team-a',
    bg: 'bg-team-a',
    soft: 'bg-team-a/10',
    edge: 'border-team-a/40',
  },
  B: {
    text: 'text-team-b',
    border: 'border-team-b',
    bg: 'bg-team-b',
    soft: 'bg-team-b/10',
    edge: 'border-team-b/40',
  },
}

/**
 * The two scoreboards — §13.
 *
 * Team average is the largest figure on each side; picks and total sit under it
 * small. That ordering is the whole §2 argument made visible: the number that
 * decides the session is the number you read first.
 */
export function teamColumns(state) {
  return `
  <div class="grid grid-cols-1 md:grid-cols-2 gap-md mb-lg">
    ${teamColumn(state, 'A')}${teamColumn(state, 'B')}
  </div>`
}

function teamColumn(state, key) {
  const skin = SKIN[key]
  const team = state.teams?.[key] ?? { name: key, emoji: '' }
  const score = key === 'A' ? state.scoreA : state.scoreB
  const total = key === 'A' ? state.totalA : state.totalB
  const picks = key === 'A' ? state.picksA : state.picksB
  const roster = (key === 'A' ? state.rosterA : state.rosterB) ?? []
  const leading = (state.scoreA ?? 0) !== (state.scoreB ?? 0) &&
    score === Math.max(state.scoreA ?? 0, state.scoreB ?? 0)

  return `
  <div class="bg-surface-container rounded-xl border-t-4 ${skin.border} ${
    leading ? 'border-x border-b ' + skin.edge : 'border-x border-b border-outline-variant'
  } overflow-hidden">
    <div class="p-md">
      <div class="flex items-center justify-between mb-sm">
        <span class="font-label-caps text-label-caps uppercase ${skin.text} font-bold tracking-widest">
          ${escapeHtml(team.emoji ?? '')} ${escapeHtml(team.name)}</span>
        ${leading ? `<span class="font-label-caps text-label-caps uppercase ${skin.text}">Leading</span>` : ''}
      </div>

      <div class="font-display-lg text-display-lg ${skin.text} leading-none">
        ${multiplier(score ?? 0)}</div>
      <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mt-xs">
        average per pick</div>

      <div class="flex gap-md mt-sm font-data-mono text-[13px] text-on-surface-variant">
        <span>${picks ?? 0} ${picks === 1 ? 'pick' : 'picks'}</span>
        <span>·</span>
        <span>${multiplier(total ?? 0)} total</span>
      </div>
    </div>

    ${crowdBar(state, key)}

    <div class="border-t border-outline-variant/40 max-h-[220px] overflow-y-auto">
      ${
        roster.length === 0
          ? '<div class="p-md text-[13px] text-on-surface-variant/60 text-center">No picks yet</div>'
          : roster.map((m) => rosterRow(m, skin)).join('')
      }
    </div>
  </div>`
}

/**
 * §7 — the crowd bar.
 *
 * It has no effect on scoring whatsoever, and that is exactly why it works: a
 * free popularity contest running in parallel to the real one. The two
 * diverging is the interesting picture, so it sits directly under the score
 * rather than off in a corner.
 */
function crowdBar(state, key) {
  const a = state.crowdA ?? 0
  const b = state.crowdB ?? 0
  const total = a + b
  if (total === 0) return ''

  const mine = key === 'A' ? a : b
  const pct = Math.round((mine / total) * 100)

  return `
  <div class="px-md pb-sm">
    <div class="flex justify-between font-label-caps text-[10px] uppercase text-on-surface-variant mb-1">
      <span>${pct}% of chat</span>
      <span>${mine} backing</span>
    </div>
    <div class="h-1.5 rounded-full bg-surface-container-low overflow-hidden">
      <div class="h-full ${SKIN[key].bg} transition-all duration-500" style="width:${pct}%"></div>
    </div>
  </div>`
}

function rosterRow(member, skin) {
  return `
  <div class="flex items-center justify-between gap-sm px-md py-xs border-b border-outline-variant/20 last:border-0">
    <span class="truncate text-[14px] flex items-center gap-xs min-w-0">
      ${
        // §6.4 — the crossed-out allegiance stays for the rest of the session.
        member.overridden
          ? `<span class="material-symbols-outlined text-[14px] text-on-surface-variant/60 shrink-0"
                   title="The coin overrode the side they called">swap_horiz</span>`
          : ''
      }
      <span class="truncate">@${escapeHtml(member.username)}</span>
    </span>
    <span class="font-data-mono text-[14px] ${skin.text} shrink-0">${multiplier(member.multiplier)}</span>
  </div>`
}

/**
 * The swing number — §9.3.
 *
 * "Bonus Hunt has break-even. Bingo has the one-away line. Team Battles has the
 * swing number." It is what makes the buying phase watchable instead of dead
 * air: the streamer is loading a bonus and there is a specific figure on screen
 * it has to beat.
 *
 * Three honest states. Fake tension is worse than no tension, so a figure
 * that's out of reach says so.
 */
export function swingHero(state) {
  const team = state.swingTeam ?? 'B'
  const skin = SKIN[team]
  const name = (state.teams?.[team]?.name ?? team).toUpperCase()
  const required = state.swing ?? 0

  if (required <= 0) {
    return `
    <div class="bg-surface-container rounded-xl border border-outline-variant p-lg text-center mb-lg">
      <div class="font-label-caps text-label-caps uppercase text-on-surface-variant">Level</div>
      <div class="font-headline-md text-headline-md mt-xs">Both teams on the same average</div>
    </div>`
  }

  const gone = required >= 100
  const longShot = required >= 20

  return `
  <div class="bg-surface-container rounded-xl border ${gone ? 'border-outline-variant' : skin.edge}
              p-lg text-center mb-lg relative overflow-hidden">
    <div class="absolute top-0 left-0 w-full h-1 ${gone ? 'bg-outline-variant' : skin.bg}"></div>
    <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-xs">
      ${escapeHtml(name)} need</div>
    <div class="font-display-lg text-display-lg ${gone ? 'text-on-surface-variant' : skin.text} leading-none">
      ${multiplier(required)}</div>
    <div class="text-on-surface-variant mt-sm">
      ${
        gone
          ? 'on this pick to lead — effectively out of reach on one bonus'
          : longShot
            ? 'on this pick to take the lead'
            : 'on this pick to take the lead — this one is live'
      }
    </div>
  </div>`
}

/**
 * The drawn entrant, before the flip — §13's pick card.
 *
 * Both team crests flank it and both stay neutral: the team is genuinely not
 * known to this page yet, because the projection withholds it until the flip
 * starts.
 */
export function pickCard(state) {
  const pick = state.currentPick
  if (!pick) return ''

  const revealed = pick.team !== null && pick.team !== undefined
  const skin = revealed ? SKIN[pick.team] : null
  const team = revealed ? state.teams?.[pick.team] : null

  return `
  <div class="bg-surface-container rounded-xl border ${revealed ? skin.edge : 'border-outline-variant'}
              p-lg mb-lg relative overflow-hidden">
    <div class="absolute top-0 left-0 w-full h-1 ${revealed ? skin.bg : 'bg-outline-variant'}"></div>

    <div class="flex items-center justify-between mb-md">
      <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">
        ${revealed ? 'Playing for' : 'Drawn — team not yet decided'}</span>
      <div class="flex items-center gap-xs">
        ${
          pick.source === 'reserved'
            ? `<span class="font-label-caps text-label-caps uppercase text-gold bg-gold/10
                           border border-gold/40 px-sm py-xs rounded">Streamer's pick</span>`
            : ''
        }
        ${
          revealed
            ? `<span class="font-label-caps text-label-caps uppercase ${skin.text} ${skin.soft}
                           border ${skin.edge} px-sm py-xs rounded">${escapeHtml(team?.name ?? '')}</span>`
            : ''
        }
      </div>
    </div>

    <div class="flex items-center gap-md">
      ${slotTile(pick.slotName, pick.thumbnail, 'w-16 h-16 rounded-lg object-cover shrink-0 text-[20px]')}
      <div class="min-w-0">
        <div class="font-headline-md text-headline-md truncate">@${escapeHtml(pick.username)}</div>
        <div class="text-on-surface-variant font-data-mono text-[14px] truncate">
          ${escapeHtml(pick.slotName ?? 'Slot pending')}</div>
      </div>
    </div>

    ${
      // §6.4 — given a distinct treatment because it is one of the best
      // recurring beats the game has.
      pick.allegianceOverridden
        ? `<div class="mt-md bg-surface-container-low border border-outline-variant/60 rounded-lg p-sm
                       flex items-center gap-sm text-[13px]">
             <span class="material-symbols-outlined text-[18px] text-on-surface-variant">swap_horiz</span>
             <span>@${escapeHtml(pick.username)} called
               <span class="line-through text-on-surface-variant">${escapeHtml(
                 state.teams?.[pick.declaredSide]?.name ?? '',
               )}</span> — the coin said
               <span class="${skin.text} font-bold">${escapeHtml(team?.name ?? '')}</span>.</span>
           </div>`
        : ''
    }
  </div>`
}

/** The running ledger — every pick, newest first, with its team's colour. */
export function ledger(state) {
  const picks = [...(state.picks ?? [])].reverse()

  return `
  <div class="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
    <div class="p-md border-b border-outline-variant bg-surface-container-high flex justify-between items-center">
      <h3 class="font-headline-md text-[18px] font-bold">Ledger</h3>
      <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">
        ${picks.filter((p) => p.multiplier !== null).length} played</span>
    </div>
    <div class="max-h-[420px] overflow-y-auto">
      ${
        picks.length === 0
          ? '<div class="p-lg text-center text-on-surface-variant/60">Nothing played yet</div>'
          : picks.map((p) => ledgerRow(p, state)).join('')
      }
    </div>
  </div>`
}

function ledgerRow(pick, state) {
  const skin = SKIN[pick.team]
  const team = state.teams?.[pick.team]
  const cost = (pick.buyCostCents ?? 0) / 100
  const payout = (pick.payoutCents ?? 0) / 100

  if (pick.vetoed) {
    return `
    <div class="px-md py-sm border-b border-outline-variant/20 last:border-0 opacity-50">
      <div class="flex justify-between items-center">
        <span class="text-[14px] truncate">@${escapeHtml(pick.username)}</span>
        <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Vetoed</span>
      </div>
      ${
        pick.vetoed.reason
          ? `<div class="text-[12px] text-on-surface-variant/70 mt-1">${escapeHtml(pick.vetoed.reason)}</div>`
          : ''
      }
    </div>`
  }

  return `
  <div class="px-md py-sm border-b border-outline-variant/20 last:border-0">
    <div class="flex items-center justify-between gap-sm">
      <span class="font-label-caps text-[10px] uppercase ${skin.text} ${skin.soft}
                   border ${skin.edge} px-xs rounded shrink-0">${escapeHtml(team?.name ?? pick.team)}</span>
      <span class="flex-1 truncate text-[14px]">@${escapeHtml(pick.username)}</span>
      <span class="font-data-mono text-[15px] shrink-0 ${
        pick.multiplier === null
          ? 'text-on-surface-variant'
          : pick.multiplier >= 1
            ? 'text-win'
            : 'text-loss'
      }">${multiplier(pick.multiplier)}</span>
    </div>
    <div class="flex justify-between text-[12px] text-on-surface-variant/70 mt-1">
      <span class="truncate">${escapeHtml(pick.slotName ?? '')}</span>
      ${
        pick.multiplier !== null
          ? `<span class="font-data-mono shrink-0">${money(cost, state.currency ?? 'EUR')} → ${money(
              payout,
              state.currency ?? 'EUR',
            )}</span>`
          : ''
      }
    </div>
    ${
      pick.revertedFrom
        ? `<div class="text-[11px] text-gold mt-1">Corrected</div>`
        : ''
    }
  </div>`
}

/** The joining screen, before pick 1. */
export function battlesJoining(state) {
  const ready = (state.entrantCount ?? 0)
  const enough = ready >= (state.maxPicks ?? 10)

  return `
  <div class="bg-surface-container rounded-xl border border-outline-variant p-lg mb-lg
              flex flex-wrap items-center justify-between gap-md">
    <div>
      <div class="font-display-lg text-display-lg leading-none">${ready}</div>
      <p class="text-on-surface-variant mt-xs">
        in the pool · viewers type
        <span class="font-data-mono text-on-surface">!join &lt;slot&gt;</span>
        ${
          // Never name a command this session has switched off.
          state.canDeclareSide === false
            ? 'to enter — the draw puts them on a team'
            : `to enter and <span class="font-data-mono text-on-surface">!side</span> to back a team`
        }
      </p>
    </div>

    <div class="text-right">
      ${
        state.joinWindowEndsAt
          ? `<div class="font-label-caps text-label-caps uppercase text-on-surface-variant">Opens pick 1 in</div>
             <div class="font-data-mono text-[28px]" id="timer" data-ends="${state.joinWindowEndsAt}">—</div>`
          : ''
      }
      <div class="mt-xs text-[13px] flex items-center gap-xs justify-end ${
        enough ? 'text-win' : 'text-gold'
      }">
        <span class="material-symbols-outlined text-[16px]">${enough ? 'check_circle' : 'info'}</span>
        ${
          enough
            ? 'Pool is deep enough for every pick'
            : `${state.maxPicks ?? 10} picks planned — joining stays open all session`
        }
      </div>
    </div>
  </div>`
}

/**
 * The final result — §8.2's three awards, and §8.3's requirement that the
 * overlay state which rung decided it.
 */
export function battlesResult(state) {
  const r = state.result
  if (!r) return ''

  const skin = SKIN[r.winner]
  const team = state.teams?.[r.winner]

  const how = {
    average: 'Higher average per pick',
    total: 'Tied on average — decided on total multiplier',
    best: 'Tied on total — decided on the better single pull',
    fewerPicks: 'Tied throughout — decided on fewer picks',
    coinflip: 'Tied on everything — decided on a seeded coin flip',
  }[r.decidedBy] ?? ''

  return `
  <div class="bg-surface-container rounded-xl border ${skin.edge} p-xl mb-lg text-center relative overflow-hidden">
    <div class="absolute top-0 left-0 w-full h-1 ${skin.bg}"></div>

    <div class="font-display-lg text-display-lg ${skin.text} mb-xs">
      ${escapeHtml((team?.name ?? '').toUpperCase())} WIN</div>
    <p class="font-headline-md text-headline-md text-on-surface mb-xs">
      ${multiplier(r.scoreA)} <span class="text-on-surface-variant">vs</span> ${multiplier(r.scoreB)}
    </p>
    ${how ? `<p class="text-on-surface-variant text-sm mb-lg">${escapeHtml(how)}</p>` : ''}

    ${
      // §16 — say plainly that one team never got a pick. It is a legendary
      // session, not a bug, and pretending otherwise looks like one.
      r.shutout
        ? `<div class="bg-gold/10 border border-gold/40 rounded-lg p-sm mb-lg text-[13px] text-on-surface">
             One team never got a single pick. At ten picks that happens about twice in a thousand sessions.
           </div>`
        : ''
    }

    <div class="grid grid-cols-1 ${r.anchor ? 'md:grid-cols-2' : ''} gap-md text-left">
      ${award('MVP', 'Biggest pull of the session', r.mvp, 'border-gold', 'text-gold')}
      ${r.anchor ? award('The Anchor', 'Lowest of the session — it happens', r.anchor, 'border-outline-variant', 'text-on-surface-variant') : ''}
    </div>
  </div>`
}

function award(title, sub, winner, border, colour) {
  if (!winner) return ''
  return `
  <div class="bg-surface-container-low rounded-lg border ${border} p-md">
    <div class="font-label-caps text-label-caps uppercase ${colour} mb-xs">${escapeHtml(title)}</div>
    <div class="font-headline-md text-[20px] truncate">@${escapeHtml(winner.username)}</div>
    <div class="text-on-surface-variant text-[13px] truncate">${escapeHtml(winner.slotName ?? '')}</div>
    <div class="font-data-mono text-[24px] ${colour} mt-xs">${multiplier(winner.multiplier)}</div>
    <div class="text-on-surface-variant/70 text-[12px] mt-1">${escapeHtml(sub)}</div>
  </div>`
}
