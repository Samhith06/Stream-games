/**
 * Wire protocol between the server and the overlay / dashboard sockets.
 *
 * §19: OBS browser sources drop constantly. On connect the server sends a full
 * snapshot; after that, patches. The client tracks `seq` and asks for a resync
 * on any gap. A silently desynced overlay is the worst failure mode we have,
 * so every downstream frame carries the sequence it corresponds to.
 */

export type SessionStatus = 'created' | 'running' | 'ended' | 'abandoned'

/** Anything a game's `project()` returns. Shape is owned by the game module. */
export type OverlayState = Record<string, unknown>

export interface SnapshotFrame {
  t: 'snapshot'
  sessionId: string
  gameId: string
  status: SessionStatus
  /** Sequence of the last event folded into this state. */
  seq: number
  /**
   * Frame counter. Distinct from `seq` because not every event changes anything
   * the overlay can see — a slot lookup that fails to match moves `seq` without
   * producing a patch. Tracking gaps on `seq` would make the overlay resync
   * constantly on a busy hunt; `frame` only skips when a frame is genuinely
   * lost.
   */
  frame: number
  state: OverlayState
  serverTime: number
}

export interface PatchFrame {
  t: 'patch'
  sessionId: string
  /** State version this patch brings the client to. */
  seq: number
  /** Contiguous per session. A gap here means a frame was actually missed. */
  frame: number
  /** Game-defined partial. Overlays merge shallowly by top-level key. */
  patch: Record<string, unknown>
  /**
   * Keys the dashboard sees and the overlay must not — the unresolved queue,
   * the raw pool, per-viewer detail (§19/§20).
   *
   * Carried on the same frame rather than a second channel so both views stay
   * on one sequence; the server strips it before an overlay socket sees it.
   */
  dashboardPatch?: Record<string, unknown>
  serverTime: number
}

export interface EndedFrame {
  t: 'ended'
  sessionId: string
  seq: number
  reason: 'complete' | 'abandoned'
  serverTime: number
}

export interface PongFrame {
  t: 'pong'
  serverTime: number
}

export interface ErrorFrame {
  t: 'error'
  code:
    | 'unauthorized'
    | 'session_not_found'
    | 'bad_request'
    | 'rate_limited'
    | 'internal'
  message: string
}

export type ServerFrame =
  | SnapshotFrame
  | PatchFrame
  | EndedFrame
  | PongFrame
  | ErrorFrame

/** Client asks for a full snapshot — sent on connect gap detection. */
export interface ResyncFrame {
  t: 'resync'
  /** Last frame the client believes it has. Server always replies snapshot. */
  haveFrame?: number
  haveSeq?: number
}

export interface PingFrame {
  t: 'ping'
}

export type ClientFrame = ResyncFrame | PingFrame

export const WS_HEARTBEAT_MS = 20_000
export const WS_CLIENT_TIMEOUT_MS = 45_000
