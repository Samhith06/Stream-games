/**
 * Overlay socket inspector.
 *
 * Connects to the overlay WebSocket exactly as an OBS browser source would and
 * prints every frame: the opening snapshot, then each patch. Use it to see what
 * the overlay will actually receive, and to confirm the sequence never gaps
 * (§19 — a silently desynced overlay is the worst failure mode in the product).
 *
 *   node scripts/watch.mjs                 # the current simulated session
 *   node scripts/watch.mjs <overlayToken>  # any session
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_FILE = join(ROOT, '.sim-session')
const BASE = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'

let token = process.argv[2]
if (!token) {
  if (!existsSync(STATE_FILE)) {
    console.error('No simulated session. Start one:  node scripts/sim.mjs new bonus-hunt')
    console.error('Or pass an overlay token:  node scripts/watch.mjs <token>')
    process.exit(1)
  }
  token = JSON.parse(readFileSync(STATE_FILE, 'utf8')).overlayToken
}

const url = `${BASE.replace(/^http/, 'ws')}/ws/overlay/${token}`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

console.log(dim(`connecting to ${url}`))

const socket = new WebSocket(url)

/**
 * Gap detection runs on `frame`, not `seq`: plenty of events change nothing the
 * overlay can see, and treating those as dropped frames would resync forever.
 */
let lastFrame = -1

socket.on('open', () => {
  console.log(dim('connected — waiting for frames (ctrl-c to stop)\n'))
  // The heartbeat an overlay would send.
  setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'ping' }))
  }, 20_000)
})

socket.on('message', (raw) => {
  const frame = JSON.parse(raw.toString())
  const stamp = new Date().toLocaleTimeString()

  if (frame.t === 'pong') return

  if (frame.t === 'snapshot') {
    lastFrame = frame.frame
    console.log(
      `${dim(stamp)} ${bold('SNAPSHOT')} seq=${frame.seq} frame=${frame.frame} phase=${frame.state.phase}`,
    )
    console.log(dim(`  keys: ${Object.keys(frame.state).join(', ')}`))
    return
  }

  if (frame.t === 'patch') {
    // A gap on `frame` means one was genuinely lost, so ask for a full snapshot.
    if (lastFrame >= 0 && frame.frame > lastFrame + 1) {
      console.log(`${dim(stamp)} \x1b[33mGAP\x1b[0m ${lastFrame} → ${frame.frame}, requesting resync`)
      socket.send(JSON.stringify({ t: 'resync', haveFrame: lastFrame }))
    }
    lastFrame = Math.max(lastFrame, frame.frame)

    const keys = Object.keys(frame.patch)
    console.log(
      `${dim(stamp)} PATCH   seq=${frame.seq} frame=${frame.frame} ` +
        `${dim(`(${keys.length} keys)`)} ${keys.join(', ')}`,
    )

    // The cues worth seeing spelled out, since they drive the animations.
    for (const cue of ['flash', 'matchResult', 'drawReveal', 'inputError']) {
      if (frame.patch[cue] !== undefined) {
        console.log(dim(`    ${cue}: ${JSON.stringify(frame.patch[cue])}`))
      }
    }
    return
  }

  if (frame.t === 'ended') {
    console.log(`${dim(stamp)} ${bold('ENDED')} ${frame.reason}`)
    return
  }

  console.log(`${dim(stamp)} ${frame.t.toUpperCase()} ${JSON.stringify(frame)}`)
})

socket.on('close', () => {
  console.log(dim('\nsocket closed'))
  process.exit(0)
})

socket.on('error', (err) => {
  console.error('socket error:', err.message)
  process.exit(1)
})
