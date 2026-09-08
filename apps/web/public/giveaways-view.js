/**
 * Giveaways' dashboard panels.
 *
 * Its own module for the same reason `battles-view.js` is: these are views
 * nothing else in the product has — a hero counter that only ever climbs, a
 * rejection strip the streamer has ninety seconds to act on, a committed order
 * only they can see, and two clocks that behave differently on purpose.
 *
 * Four rules run through all of it, and each one is a spec section rather than
 * a preference:
 *
 * **The overlay counter never goes backwards** (§13). Removals and rejections
 * are subtracted from the figures on *this* screen and never from the one on
 * stream. A hero number that drops by forty in front of the whole channel
 * invites exactly one conclusion.
 *
 * **Closing does not close** (§2). The button starts a fifteen-second visible
 * countdown and then a hidden grace period, and it says so — the streamer needs
 * to understand why the count keeps moving after zero, and the audience must
 * never learn there was a grace at all.
 *
 * **Every intervention carries a reason and shows on the overlay** (§8.4). The
 * product's entire trust position rests on discretion being visible rather than
 * absent, so a silent "award manually" would undo more than it enables.
 *
 * **There is no re-draw control here, and there is not going to be one** (§3,
 * §11). The order was committed when entry opened; the draw button reveals it.
 *
 * Pure rendering — every function takes projected state and returns HTML.
 */

import { escapeHtml } from './app.js'

/** Whole seconds, never sub-second — a giveaway clock is not a slot machine. */
export function clock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const ROLE_LABEL = { mod: 'Mod', subscriber: 'Sub', vip: 'VIP', follower: 'Follower', viewer: 'Viewer' }

// ─── entry open ─────────────────────────────────────────────────────────────

/**
 * The hero row — §13, and UI §2: "the entry counter is the only thing happening
 * for three minutes, so build it like a hero."
 *
 * The count is the number the audience is collectively producing and watching
 * it climb is the entire entertainment of the phase. The clock sits beside it
 * with the grace named underneath, because the streamer is the only person who
 * should ever know the grace exists.
 */
export function entryHero(state) {
  const count = state.entryCount ?? 0
  const closesAt = state.entryClosesAtMs
  const odds = state.oddsOneIn

  return `
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-lg mb-lg">
    <div class="lg:col-span-2 bg-surface-container border border-outline-variant/50 rounded-xl p-lg relative overflow-hidden">
      <div class="absolute -right-16 -top-16 w-64 h-64 bg-primary/10 rounded-full blur-3xl pointer-events-none"></div>
      <div class="relative flex items-start justify-between gap-lg">
        <div>
          <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-xs">Entries</div>
          <div id="ga-count" class="font-data-mono text-[68px] leading-none font-extrabold tabular-nums
                                    text-on-surface transition-colors duration-200">${count.toLocaleString()}</div>
          <div class="text-[13px] text-on-surface-variant mt-sm">
            ${odds ? `Every entry is 1 in ${odds.toLocaleString()} right now.` : 'Nobody in yet.'}
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-xs">Command</div>
          <div class="font-data-mono text-2xl text-primary font-bold">!${escapeHtml(state.keyword ?? 'drop')}</div>
          <div class="text-[12px] text-on-surface-variant mt-sm max-w-[14rem]">
            ${escapeHtml(state.gateLine ?? '')}
          </div>
        </div>
      </div>
    </div>

    <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-lg flex flex-col justify-between">
      <div class="font-label-caps text-label-caps uppercase text-on-surface-variant">Time remaining</div>
      <div>
        <div class="font-data-mono text-[52px] leading-none font-extrabold tabular-nums
                    ${state.closing ? 'text-gold' : 'text-on-surface'}"
             data-ga-clock="${closesAt ?? ''}">${closesAt ? clock(closesAt - Date.now()) : '—'}</div>
        <div class="text-[12px] text-on-surface-variant mt-sm leading-relaxed">
          ${
            /*
             * §2 — "the streamer sees the grace; the audience never does."
             * Without this line the streamer watches the count keep climbing
             * past zero and concludes something is broken.
             */
            'Plus a few seconds of grace after zero, so a viewer on a slow connection who typed when their screen said zero still gets in. Nothing about it reaches the overlay.'
          }
        </div>
      </div>
    </div>
  </div>`
}

/**
 * The rejection strip — UI §2, "the highest-value control on this screen".
 *
 * A streamer who set gating too tight is watching a third of their channel
 * bounce off it and has about ninety seconds to notice. So the number is large,
 * the reasons are named, and loosening one is a single click.
 *
 * Not collapsed by default, unlike every other game's version of this panel.
 */
export function rejectionStrip(state) {
  const rejected = state.rejected ?? {}
  const total = state.rejectedTotal ?? 0
  if (total === 0) return ''

  const COPY = {
    gate: ['Not eligible', 'Open entry to everyone'],
    'follow-age': ['Following too recently', 'Drop the follow-age requirement'],
    'account-age': ['Account too new', 'Drop the account-age requirement'],
    blocked: ['Blocked on this channel', null],
    removed: ['Removed by a mod', null],
    late: ['Arrived after the grace', null],
    closed: ['Entry was not open', null],
  }

  const chips = Object.entries(rejected)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => {
      const [label, remedy] = COPY[reason] ?? [reason, null]
      return `
      <div class="flex items-center gap-sm px-sm py-xs bg-surface-container-lowest rounded-lg
                  border border-outline-variant/50">
        <span class="text-[13px] text-on-surface-variant">${escapeHtml(label)}</span>
        <span class="font-data-mono text-gold font-bold">${n}</span>
        ${
          remedy && state.phase === 'open'
            ? `<button data-ga-loosen="${reason}" title="${escapeHtml(remedy)}"
                 class="ml-xs px-sm py-0.5 rounded text-[11px] font-label-caps uppercase
                        bg-surface-container hover:bg-surface-container-high text-primary transition-colors">
                 Loosen</button>`
            : ''
        }
      </div>`
    })
    .join('')

  return `
  <div class="bg-surface-container-high border border-outline-variant/50 rounded-xl p-md mb-lg
              flex flex-col lg:flex-row lg:items-center justify-between gap-md">
    <div class="flex items-center gap-md">
      <span class="material-symbols-outlined text-gold text-[22px]">filter_alt_off</span>
      <div>
        <div class="font-bold">${total} ${total === 1 ? 'entry' : 'entries'} didn't count</div>
        <div class="text-[12px] text-on-surface-variant">
          Nobody was told — the bot never replies to an entrant. One batched summary goes to chat at thirty seconds remaining.
        </div>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-sm">${chips}</div>
  </div>`
}

/**
 * The live entry feed — §13, "the feed is the proof that entries are landing".
 *
 * Newest first, with the computed weight as a chip when weighting is on. It is
 * the only confirmation that exists anywhere that a viewer's entry was accepted,
 * since nothing is ever acked to them.
 */
export function entryFeed(state) {
  const entries = (state.entries ?? []).slice().reverse().slice(0, 12)
  const weighted = entries.some((e) => (e.weight ?? 1) !== 1)

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl overflow-hidden">
    <div class="px-md py-sm border-b border-outline-variant/50 flex items-center justify-between">
      <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Entries as they land</span>
      <span class="text-[12px] text-on-surface-variant font-data-mono">${(state.entryCount ?? 0).toLocaleString()} total</span>
    </div>
    <div class="divide-y divide-outline-variant/30 max-h-[22rem] overflow-y-auto">
      ${
        entries.length === 0
          ? `<div class="p-lg text-center text-on-surface-variant text-sm">
               Nothing yet. The overlay is showing the keyword.</div>`
          : entries
              .map(
                (e) => `
        <div class="flex items-center justify-between px-md py-sm">
          <div class="flex items-center gap-sm min-w-0">
            <span class="font-bold truncate">@${escapeHtml(e.username)}</span>
            <span class="font-label-caps text-label-caps uppercase text-on-surface-variant
                         bg-surface-container-lowest px-sm py-0.5 rounded shrink-0">
              ${escapeHtml(ROLE_LABEL[e.role] ?? e.role)}</span>
          </div>
          ${
            weighted
              ? `<span class="font-data-mono text-sm ${(e.weight ?? 1) > 1 ? 'text-primary' : 'text-on-surface-variant'}">
                   ${e.weight}x</span>`
              : ''
          }
        </div>`,
              )
              .join('')
      }
    </div>
  </div>`
}

/** §6.1 — computed odds per tier, never ticket counts. */
export function oddsPanel(state) {
  const tiers = state.oddsTiers ?? []
  if (tiers.length === 0) return ''

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-md flex flex-col gap-sm">
    <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Odds right now</span>
    ${tiers
      .map(
        (t) => `
      <div class="flex items-center justify-between">
        <span class="text-sm text-on-surface-variant">
          ${t.weight === 1 ? 'A standard entry' : `A ${t.weight}x entry`}
          <span class="text-on-surface-variant/60">· ${t.count}</span>
        </span>
        <span class="font-data-mono ${t.weight > 1 ? 'text-primary' : 'text-on-surface'}">
          ${t.oneIn ? `1 in ${t.oneIn.toLocaleString()}` : '—'}</span>
      </div>`,
      )
      .join('')}
    <p class="text-[12px] text-on-surface-variant/70 leading-relaxed pt-xs border-t border-outline-variant/30">
      Computed against the number of prizes, which is what keeps it true in a small pool. This is what chat sees, not a ticket count.
    </p>
  </div>`
}

// ─── locked & draw ──────────────────────────────────────────────────────────

/**
 * `LOCKED` — §4's held beat, and the payoff for the window.
 *
 * "Do not skip it; the number is the payoff for the window and the audience has
 * been watching it climb." The button copy is doing real work: the streamer
 * should not feel — or be accused of — deciding anything here.
 */
export function lockedPanel(state) {
  const count = state.entryCount ?? 0
  const prize = currentPrize(state)

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-xl mb-lg text-center">
    <div class="font-label-caps text-label-caps uppercase text-loss mb-sm">Entries closed</div>
    <div class="font-data-mono text-[72px] leading-none font-extrabold tabular-nums text-on-surface">
      ${count.toLocaleString()}</div>
    <div class="text-on-surface-variant mt-sm">in for ${escapeHtml(prize?.title ?? 'this prize')}</div>

    <div class="mt-lg flex items-center justify-center gap-sm text-[13px] text-on-surface-variant">
      <span class="material-symbols-outlined text-[18px]">lock</span>
      The order was fixed when you opened entry. This reveals it.
    </div>
  </div>`
}

/**
 * The reel mirror — UI §3, so the streamer is not watching their own stream on
 * delay to find out who won.
 */
export function reelMirror(state) {
  const names = state.reelNames ?? []
  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-lg mb-lg">
    <div class="flex items-center justify-between mb-md">
      <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Overlay mirror</span>
      <button data-ga-skip class="px-sm py-xs rounded text-[12px] font-label-caps uppercase
        bg-surface-container-lowest hover:bg-surface-container-high text-primary transition-colors">
        Skip animation</button>
    </div>
    <div class="h-32 rounded-lg bg-surface-container-lowest overflow-hidden relative flex items-center justify-center">
      <div class="absolute inset-x-0 h-10 border-y border-primary/50 bg-primary/5 pointer-events-none"></div>
      <div class="ga-reel-mirror flex flex-col items-center gap-2 font-bold text-lg text-on-surface-variant">
        ${names.slice(0, 8).map((n) => `<div>@${escapeHtml(n)}</div>`).join('')}
      </div>
    </div>
    <p class="text-[12px] text-on-surface-variant/70 mt-sm">
      Playback of a result that already exists. Skipping changes nothing.
    </p>
  </div>`
}

// ─── claim & passover ───────────────────────────────────────────────────────

/**
 * The claim window — UI §1, "the main event, not the reveal".
 *
 * On screen roughly thirty times longer than the reveal is, so it gets its own
 * layout rather than a badge stuck onto a winner card. The clock is the
 * second-largest thing here and it counts down toward something bad, which is
 * the one place in this product where a red countdown is correct.
 */
export function claimHero(state) {
  const claim = state.claim
  if (!claim) return ''

  const prize = state.prizes?.[claim.prizeIndex]
  const window = state.claimWindowMs ?? 180_000
  const remaining = Math.max(0, claim.expiresAtMs - Date.now())
  const started = Date.now() >= claim.startedAtMs
  const passedOver = state.passovers ?? []

  return `
  ${passoverBanner(passedOver, state)}

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-lg mb-lg">
    <div class="lg:col-span-2 bg-surface-container border border-outline-variant/50 rounded-xl p-lg">
      <div class="font-label-caps text-label-caps uppercase text-win mb-sm">Winner</div>
      <div class="text-[40px] leading-none font-extrabold text-on-surface">@${escapeHtml(claim.username)}</div>
      <div class="text-gold font-bold text-lg mt-sm">${escapeHtml(prize?.title ?? 'Prize')}</div>

      <div class="mt-lg pt-md border-t border-outline-variant/30 text-[13px] text-on-surface-variant">
        ${
          started
            ? `Waiting for <span class="font-data-mono text-primary">!claim</span> in chat. Reminders go out at half and a fifth of the window, addressed to them.`
            : `The announcement has not reached chat yet. Their clock starts when it does — the stream delay is not spent before they can know they won.`
        }
      </div>
    </div>

    <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-lg flex flex-col items-center justify-center">
      <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-sm">Time to claim</div>
      <div class="font-data-mono text-[56px] leading-none font-extrabold tabular-nums ${claimTone(remaining, window)}"
           data-ga-claim="${claim.expiresAtMs}" data-ga-window="${window}">${clock(remaining)}</div>
      <div class="w-full h-2 mt-md rounded-full bg-surface-container-lowest overflow-hidden">
        <div class="h-full rounded-full bg-current ${claimTone(remaining, window)} transition-all duration-500"
             style="width:${Math.round((remaining / window) * 100)}%"></div>
      </div>
    </div>
  </div>`
}

/** Gold, then amber, then red — UI's two-clocks note. */
function claimTone(remaining, window) {
  if (remaining <= 30_000) return 'text-loss'
  if (remaining <= window / 2) return 'text-gold'
  return 'text-gold'
}

/**
 * §8.3 — the passed-over names, struck through, for the rest of the session.
 *
 * "Openly, every time. A silent substitution is the single most suspicious
 * thing this product could do."
 */
function passoverBanner(passovers, state) {
  const forThisPrize = passovers.filter((p) => p.prizeIndex === state.currentPrizeIndex)
  if (forThisPrize.length === 0) return ''

  return `
  <div class="bg-surface-container-low border border-outline-variant/50 rounded-xl p-md mb-lg
              flex flex-wrap items-center gap-md">
    <span class="font-label-caps text-label-caps uppercase text-loss shrink-0">
      Passover ${forThisPrize.length} of ${state.maxPassovers ?? 3}</span>
    ${forThisPrize
      .map(
        (p) => `
      <span class="flex items-center gap-sm px-sm py-xs rounded-lg bg-surface-container-lowest">
        <span class="line-through text-on-surface-variant">@${escapeHtml(p.username)}</span>
        <span class="text-[11px] text-loss font-label-caps uppercase">
          ${p.reason === 'expired' ? "didn't claim in time" : 'passed over by you'}</span>
      </span>`,
      )
      .join('')}
  </div>`
}

/**
 * §8.4 — the committed order, ahead of the cursor.
 *
 * "Deliberately visible to the streamer and deliberately not on the overlay:
 * chat seeing the next name before the passover would replace the reveal with
 * an anticlimax, and the streamer seeing it costs nothing because they cannot
 * change it."
 */
export function orderPanel(state) {
  const next = state.nextInOrder ?? []

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-md flex flex-col gap-sm">
    <div class="flex items-center justify-between">
      <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Next up if unclaimed</span>
      <span class="flex items-center gap-xs text-[11px] font-label-caps uppercase text-gold">
        <span class="material-symbols-outlined text-[14px]">visibility_off</span>Not on the overlay</span>
    </div>
    ${
      next.length === 0
        ? `<div class="text-sm text-on-surface-variant">Nobody left in the order.</div>`
        : next
            .map(
              (name, i) => `
      <div class="flex items-center gap-sm px-sm py-xs rounded-lg bg-surface-container-lowest">
        <span class="font-data-mono text-on-surface-variant w-4">${i + 1}</span>
        <span class="text-on-surface-variant">@${escapeHtml(name)}</span>
      </div>`,
            )
            .join('')
    }
    <p class="text-[12px] text-on-surface-variant/70 leading-relaxed pt-xs border-t border-outline-variant/30">
      Fixed when you opened entry. You are seeing it, not choosing it.
    </p>
  </div>`
}

/**
 * §8.4 — when the passovers run out, the session stops and asks.
 *
 * Three equal-weight choices with their consequences stated, because each one
 * means something different in the record and the platform must not pick on the
 * streamer's behalf. The third is shaped so that the only way to get a second
 * draw is one that is visibly a second draw.
 */
export function exhaustedPanel(state) {
  const last = state.passovers?.[state.passovers.length - 1]

  return `
  <div class="bg-surface-container border border-gold/40 rounded-xl p-lg mb-lg">
    <div class="flex items-center gap-sm mb-md">
      <span class="material-symbols-outlined text-gold">pause_circle</span>
      <span class="font-bold">That's ${state.passovers?.length ?? 0} passes. Your call from here.</span>
    </div>
    <p class="text-[13px] text-on-surface-variant mb-lg leading-relaxed">
      Nothing happens until you choose, and whichever you pick is recorded and shown as what it was.
    </p>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-md">
      <button data-ga-award-last class="text-left p-md rounded-lg bg-surface-container-low
        border border-outline-variant hover:border-primary transition-colors">
        <div class="font-bold mb-xs">Award it to @${escapeHtml(last?.username ?? 'them')} anyway</div>
        <div class="text-[12px] text-on-surface-variant">Recorded as a manual award, with your reason, badged on the overlay.</div>
      </button>
      <button data-ga-void class="text-left p-md rounded-lg bg-surface-container-low
        border border-outline-variant hover:border-loss transition-colors">
        <div class="font-bold mb-xs">Void this prize</div>
        <div class="text-[12px] text-on-surface-variant">Nobody gets it. Recorded and announced.</div>
      </button>
      <button data-ga-fresh class="text-left p-md rounded-lg bg-surface-container-low
        border border-outline-variant hover:border-primary transition-colors">
        <div class="font-bold mb-xs">Run a fresh giveaway for it</div>
        <div class="text-[12px] text-on-surface-variant">A new session with a new seed. Everyone enters again.</div>
      </button>
    </div>
  </div>`
}

// ─── complete ───────────────────────────────────────────────────────────────

/**
 * The winners record — §9, "the deliverable of the whole session".
 *
 * It is what a streamer looks at afterwards to see who they still owe, so the
 * method column is not decoration: claimed, awarded by hand, or voided are
 * three different facts about a prize.
 */
export function winnersTable(state) {
  const prizes = state.prizes ?? []
  const awards = state.awards ?? []
  const passovers = state.passovers ?? []

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl overflow-hidden mb-lg">
    <div class="px-md py-sm border-b border-outline-variant/50 font-label-caps text-label-caps
                uppercase text-on-surface-variant">Winners</div>
    <div class="divide-y divide-outline-variant/30">
      ${prizes
        .map((prize) => {
          const award = awards.find((a) => a.prizeIndex === prize.index)
          const passed = passovers.filter((p) => p.prizeIndex === prize.index)

          return `
        <div class="p-md flex flex-col gap-sm">
          <div class="flex items-center justify-between gap-md flex-wrap">
            <div class="min-w-0">
              <div class="font-bold text-gold">${escapeHtml(prize.title)}</div>
              ${award && award.username
                ? `<div class="text-lg font-bold">@${escapeHtml(award.username)}</div>`
                : `<div class="text-on-surface-variant">Nobody</div>`}
            </div>
            ${award ? methodChip(award) : ''}
          </div>
          ${
            passed.length > 0
              ? `<div class="flex flex-wrap gap-sm">
                   ${passed
                     .map(
                       (p) => `<span class="text-[12px] px-sm py-xs rounded bg-surface-container-lowest
                                            text-on-surface-variant line-through">@${escapeHtml(p.username)}</span>`,
                     )
                     .join('')}
                 </div>`
              : ''
          }
        </div>`
        })
        .join('')}
    </div>
  </div>`
}

function methodChip(award) {
  const [text, tone] =
    award.method === 'claimed'
      ? [
          award.claimedWithMsLeft !== null
            ? `Claimed with ${clock(award.claimedWithMsLeft)} left`
            : 'Claimed',
          'text-win bg-win/10 border-win/40',
        ]
      : award.method === 'manual'
        ? ['Awarded by you', 'text-gold bg-gold/10 border-gold/40']
        : ['Voided', 'text-loss bg-loss/10 border-loss/40']

  return `
  <div class="flex flex-col items-end gap-xs shrink-0">
    <span class="font-label-caps text-label-caps uppercase px-sm py-xs rounded border ${tone}">${escapeHtml(text)}</span>
    ${award.manualReason
      ? `<span class="text-[11px] text-on-surface-variant">${escapeHtml(award.manualReason)}</span>`
      : ''}
  </div>`
}

/**
 * §8.3 — "watch the claim rate. It is the health metric of this game."
 *
 * A large figure rather than a stat buried in a row, because a channel trending
 * under 50% is being told something specific about its timing or its prizes and
 * neither is discoverable any other way.
 */
export function sessionStats(state) {
  const rate = state.claimRate
  const rejected = state.rejectedTotal ?? 0

  return `
  <div class="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
    ${statTile('Entries', (state.entryCount ?? 0).toLocaleString(), 'text-on-surface')}
    ${statTile(
      'Claim rate',
      rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`,
      rate !== null && rate !== undefined && rate < 0.5 ? 'text-loss' : 'text-win',
    )}
    ${statTile('Passovers', String((state.passovers ?? []).length), 'text-on-surface-variant')}
    ${statTile("Didn't count", String(rejected), rejected > 0 ? 'text-gold' : 'text-on-surface-variant')}
  </div>
  ${
    rate !== null && rate !== undefined && rate < 0.5
      ? `<div class="bg-gold/10 border-l-4 border-gold rounded-r-lg p-md mb-lg text-[13px] leading-relaxed">
           Under half your winners claimed. That is usually the claim window being too short for your stream delay, or a prize the audience did not want — both are worth changing before the next one.
         </div>`
      : ''
  }`
}

function statTile(label, value, tone) {
  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-md">
    <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-xs">${escapeHtml(label)}</div>
    <div class="font-data-mono text-3xl font-extrabold tabular-nums ${tone}">${escapeHtml(value)}</div>
  </div>`
}

/**
 * §3's verification card — the seed, the fingerprint it matches, and a link.
 *
 * "This costs a template and it turns 'prove it' into a URL." The seed is only
 * here once the session has finished; before that the panel shows the
 * fingerprint alone, which is the whole point of the commitment.
 */
export function verificationCard(state, sessionId) {
  const url = `${location.origin}/verify/${sessionId}`

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-lg flex flex-col gap-md">
    <div class="flex items-center gap-sm">
      <span class="material-symbols-outlined text-primary">verified_user</span>
      <span class="font-bold">Anyone can check this</span>
    </div>

    <div class="flex flex-col gap-sm">
      <div>
        <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-xs">
          Fingerprint, posted to chat before the first entry</div>
        <div class="font-data-mono text-sm text-primary bg-surface-container-lowest rounded px-sm py-xs break-all">
          ${escapeHtml(state.seedHash ?? '—')}</div>
      </div>
      ${
        state.seed
          ? `<div>
               <div class="font-label-caps text-label-caps uppercase text-on-surface-variant mb-xs">
                 Seed, published now the session is over</div>
               <div class="font-data-mono text-sm text-gold bg-surface-container-lowest rounded px-sm py-xs break-all">
                 ${escapeHtml(state.seed)}</div>
             </div>`
          : `<div class="text-[13px] text-on-surface-variant">
               The seed stays secret until the session ends. Publishing it now would let anyone holding the entry list read off every remaining name.
             </div>`
      }
    </div>

    ${
      state.seed
        ? `<div class="flex flex-wrap gap-sm pt-sm border-t border-outline-variant/30">
             <button data-ga-copy-verify="${escapeHtml(url)}"
               class="px-md py-sm rounded-lg bg-surface-container-low hover:bg-surface-container-high
                      border border-outline-variant font-label-caps text-label-caps uppercase transition-colors">
               Copy verification link</button>
             <a href="/api/verify/${escapeHtml(sessionId)}/entries.csv"
               class="px-md py-sm rounded-lg bg-surface-container-low hover:bg-surface-container-high
                      border border-outline-variant font-label-caps text-label-caps uppercase transition-colors">
               Download entry list</a>
           </div>`
        : ''
    }
  </div>`
}

// ─── shared ─────────────────────────────────────────────────────────────────

export function currentPrize(state) {
  const index = state.currentPrizeIndex
  if (index === null || index === undefined) return state.prizes?.[0] ?? null
  return state.prizes?.[index] ?? null
}

/** §7.2 — one at a time, smallest first, best prize last. */
export function prizeQueue(state) {
  const prizes = state.prizes ?? []
  if (prizes.length <= 1) return ''

  return `
  <div class="bg-surface-container border border-outline-variant/50 rounded-xl p-md flex flex-col gap-sm">
    <span class="font-label-caps text-label-caps uppercase text-on-surface-variant">Prizes this session</span>
    ${prizes
      .map((p) => {
        const active = p.index === state.currentPrizeIndex
        const done = p.status === 'claimed' || p.status === 'voided'
        return `
      <div class="flex items-center justify-between px-sm py-xs rounded-lg
                  ${active ? 'bg-primary/10 border border-primary/40' : 'bg-surface-container-lowest'}">
        <div class="flex items-center gap-sm min-w-0">
          <span class="font-data-mono text-on-surface-variant w-4">${p.index + 1}</span>
          <span class="truncate ${done ? 'text-on-surface-variant' : 'text-on-surface'}">${escapeHtml(p.title)}</span>
        </div>
        <span class="text-[11px] font-label-caps uppercase shrink-0
                     ${p.status === 'claimed' ? 'text-win' : p.status === 'voided' ? 'text-loss' : active ? 'text-primary' : 'text-on-surface-variant'}">
          ${p.status === 'claimed' ? 'Settled' : p.status === 'voided' ? 'Voided' : active ? 'Live' : 'Waiting'}</span>
      </div>`
      })
      .join('')}
    <p class="text-[12px] text-on-surface-variant/70 pt-xs border-t border-outline-variant/30">
      Revealed in this order. The last one is the last thing the audience sees.
    </p>
  </div>`
}
