/**
 * Game 3 — Slot Bingo.
 *
 * "Adding game #3 is a single line in the registry plus a package. If it ever
 * needs more than that, the GameModule contract is missing an abstraction."
 * It didn't: the pool, the seeded draw and the slot catalog all came across
 * from Tournament unchanged.
 *
 * Retries (§6.5) are not implemented — see types.ts. `retriesPerSquare: 0` is
 * the default and the game every other section of the spec describes.
 */

import type { GameModule, InitContext } from '@streamarena/core'
import { round2 } from '@streamarena/core'
import { buildLines, buildSquares, lineCountFor, squareId } from './board.js'
import { aliveLines, bestLine, recomputeLines } from './lines.js'
import { lineLabel, picksUntilNextUnlock, reduce } from './reduce.js'
import { bingoConfigSchema, type BingoConfig, type BingoState } from './types.js'

export const slotBingo: GameModule<BingoState, BingoConfig> = {
  id: 'slot-bingo',
  stateVersion: 1,
  displayName: 'Slot Bingo',
  tagline: 'Viewers claim a square each. Every bonus that greens builds a line — five in a row ends it.',

  configSchema: bingoConfigSchema,
  subscriptions: ['chat.message.sent'],

  commands: [
    {
      id: 'join',
      keywords: ['join', 'enter'],
      description: 'Claim a square with a slot',
      // The configured joinGate is applied as a per-channel override by the
      // runtime, so the game never re-implements role checking.
      gate: 'anyone',
      cooldownMs: 10_000,
      perUserLimit: 0, // replacing your pick must not count as a second use
      globalLimit: 0,
    },
    {
      id: 'board',
      keywords: ['board', 'lines'],
      description: 'Lines alive, squares played, current best line',
      gate: 'anyone',
      cooldownMs: 30_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
    {
      id: 'mysquare',
      keywords: ['mysquare', 'square', 'my'],
      description: 'Which square you hold and whether your lines are alive',
      gate: 'anyone',
      cooldownMs: 20_000,
      perUserLimit: 0,
      globalLimit: 0,
    },
  ],

  initialState(config, _ctx: InitContext): BingoState {
    const size = config.size
    const squares = buildSquares(size)
    const lines = buildLines(size)

    return {
      phase: 'joining',
      size,
      greenThresholdX: config.greenThresholdX,
      bigWinThresholdX: config.bigWinThresholdX,
      freeCentre: config.freeCentre,

      retriesPerSquare: config.retriesPerSquare,
      retryModel: config.retryModel,
      retrySlot: config.retrySlot,
      burnPlayedSlots: config.burnPlayedSlots,
      rebuyTokens: config.rebuyTokens,
      rebuyTokensUsed: 0,
      suddenDeathAfterRound: config.suddenDeathAfterRound,
      suddenDeathActive: false,
      budgetCapCents: config.budgetCapCents,
      maxBuys: config.maxBuys,

      pool: [],
      reservedUserIds: [],
      drawCompleted: false,

      standby: [],
      joinsOpen: true,
      unlockSchedule: [],
      unlocksDone: 0,
      lastUnlockSeq: null,

      squares,
      lines,

      pickOrder: [],
      pickCursor: 0,
      currentSquareId: null,
      round: 1,
      roundOrder: [],

      joinWindowEndsAt: null,
      joinsClosed: false,

      bingoLines: [],
      winningLine: null,
      winners: [],
      decidedBy: null,
      settledEarly: false,

      lastStatusReplyAt: null,
      announcedOneAway: [],
    }
  },

  reduce,

  /**
   * The overlay's view — §19: no user ids, ever. Usernames only, because that
   * is what goes on stream.
   */
  project(state) {
    const lines = state.lines
    const alive = aliveLines(lines)
    const best = bestLine(alive, () => 0)
    const totals = runningTotals(state)

    return {
      phase: state.phase,
      size: state.size,
      freeCentre: state.freeCentre,
      greenThresholdX: state.greenThresholdX,
      bigWinThresholdX: state.bigWinThresholdX,

      squares: state.squares.map((square) => {
        const settling = square.attempts[square.attempts.length - 1]
        return {
          id: square.id,
          row: square.row,
          col: square.col,
          owner: square.owner,
          username: square.username,
          slotName: square.slotName,
          thumbnail: square.thumbnail,
          status: square.status,
          tier: square.tier,
          multiplier: settling?.multiplier ?? null,
          payout: settling?.payout ?? null,
          manualPick: square.manualPick,
          source: square.source,
          /** Drives "OPENS PICK 12" on a held-back square. */
          unlockAfterPick: square.unlockAfterPick,
          /** §5.1 — the placement advantage, shown rather than hidden. */
          lineCount: lineCountFor(square, state.size),
        }
      }),

      lines: lines.map((line) => ({
        id: line.id,
        label: lineLabel(line.id),
        squareIds: line.squareIds,
        state: line.state,
        totalMultiplier: line.totalMultiplier,
        netScore: line.netScore,
        greenCount: line.greenCount,
      })),

      // §7 — the tension meter, one number on screen.
      linesAlive: alive.length,
      linesTotal: lines.length,
      squaresPlayed: state.squares.filter((s) => s.status === 'settled').length,
      squaresTotal: state.squares.length,

      currentSquareId: state.currentSquareId,
      /** §7.1 — the armed square that could end the board right now. */
      matchPointLines: state.currentSquareId
        ? lines
            .filter((l) => l.state === 'oneAway' && l.squareIds.includes(state.currentSquareId!))
            .map((l) => l.id)
        : [],

      bestLineId: best?.line.id ?? null,
      bestLineMultiplier: best?.line.totalMultiplier ?? null,

      // The bonus-hunt meter, free — §10 derived.
      totalSpent: totals.spent,
      totalReturned: totals.returned,
      netPosition: totals.net,
      bestSquare: totals.bestSquare,

      entrantCount: state.pool.length + state.standby.length + claimedCount(state),
      standbyCount: state.standby.length,
      picksUntilNextUnlock: picksUntilNextUnlock(state),
      joinsOpen: state.joinsOpen,
      joinWindowEndsAt: state.joinWindowEndsAt,

      bingoLines: state.bingoLines,
      winningLine: state.winningLine,
      winners: state.winners.map((w) => ({
        username: w.username,
        slotName: w.slotName,
        squareId: w.squareId,
      })),
      decidedBy: state.decidedBy,
      settledEarly: state.settledEarly,
    }
  },

  /**
   * The dashboard sees everything the overlay does plus what the streamer needs
   * to act: the unresolved queue, and the pool with the user ids that reserve
   * and remove act on.
   */
  projectDashboard(state) {
    return {
      pool: state.pool.map(poolRow),
      standby: state.standby.map(poolRow),
      reservedUserIds: state.reservedUserIds,
      unresolved: [...state.pool, ...state.standby]
        .filter((m) => m.slotId === null)
        .map((m) => ({
          userId: m.userId,
          username: m.username,
          rawText: m.rawText,
          suggestions: m.suggestions,
        })),
      pickOrder: state.pickOrder,
      pickCursor: state.pickCursor,
      drawCompleted: state.drawCompleted,
      unlockSchedule: state.unlockSchedule,
      unlocksDone: state.unlocksDone,
    }
  },

  phaseOf: (state) => state.phase,
}

function poolRow(m: BingoState['pool'][number]) {
  return {
    userId: m.userId,
    username: m.username,
    slotId: m.slotId,
    slotName: m.slotName,
    thumbnail: m.thumbnail,
    rawText: m.rawText,
  }
}

const claimedCount = (state: BingoState) =>
  state.squares.filter((s) => s.owner === 'viewer').length

/**
 * The running P&L — §10.
 *
 * Every attempt counts, reds included: that is the number the streamer and chat
 * have been watching all session, and it is the same currency a line's net
 * score is denominated in.
 */
function runningTotals(state: BingoState) {
  let spent = 0
  let returned = 0
  let bestSquare: { squareId: string; multiplier: number } | null = null

  for (const square of state.squares) {
    for (const attempt of square.attempts) {
      spent += attempt.buyCost
      returned += attempt.payout
      if (!bestSquare || attempt.multiplier > bestSquare.multiplier) {
        bestSquare = { squareId: square.id, multiplier: attempt.multiplier }
      }
    }
  }

  return {
    spent: round2(spent),
    returned: round2(returned),
    net: round2(returned - spent),
    bestSquare,
  }
}

export { squareId, recomputeLines, lineLabel }
export * from './types.js'
