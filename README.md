# StreamArena — backend

Implementation of `StreamArena-Master-Spec.md`. Section references below (§7, §13…) point at that document.

A **chat-driven game runtime** (§7) with two games as plugins: Bonus Hunt with Guess the Balance, and Slot Tournament. The runtime owns Kick, persistence, chat policy and transport; a game owns only its state, its reducer and its projection.

---

## Running it

```bash
npm install
npm run build             # tsc -b, then compiles the stylesheet
npm run infra:up          # Postgres on 55432, Redis on 56379
cp .env.example .env      # then fill in the secrets below
npm run db:migrate
npm run db:seed           # 30 slots, 62 aliases
```

Two processes, as in §8:

```bash
npm run start:web         # HTTP + WebSocket, port 3000
npm run start:worker      # game logic, Kick calls, scheduled jobs
```

Required secrets in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # SESSION_SECRET
```

`KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` come from a Kick developer app. Everything except live chat works without them.

### The front-end

Plain HTML plus ES modules in `apps/web/public`, served from the API origin so
the session cookie is same-origin and there is no second deployment to keep in
step. The one build step is the stylesheet:

```bash
npm run dev:css           # rebuild apps/web/public/tailwind.css on change
```

`npm run build` does it once; `tailwind.css` is generated and not committed.
Tailwind's scanner reads **source text**, so a class has to appear whole in a
file — `` `text-${accent}` `` compiles to nothing. Pass complete class names
(`'text-primary'`), never bare colour tokens (`'primary'`).

Both palettes live in `apps/web/styles/app.css` as CSS variables: purple for
Bonus Hunt and the shell, indigo for tournaments. Token names are identical in
each, so switching is one attribute on `<html>` — `setGameTheme(gameId)` in
`theme.js`. The overlay is deliberately separate: hand-written CSS, no Tailwind,
no framework, so nothing on stream depends on the dashboard's build.

### Tests

```bash
npm run build             # tests import built dist for cross-package specifiers
npm test                  # 104 unit tests, no infrastructure needed
npm run test:smoke        # end-to-end vs real Postgres + Redis
npm run test:pipeline     # drives the real queues; needs the worker running
```

### Driving it by hand

`scripts/sim.mjs` runs a real session with no Kick account and no dashboard. It
publishes to the same queues the webhook receiver does, so everything past step 1
of the pipeline is the real code path — router, guards, reducer, catalog, timers,
effects. Only Kick's delivery is faked.

```bash
node scripts/sim.mjs new bonus-hunt
node scripts/sim.mjs flood 6 "!sr gates"          # six viewers at once
node scripts/sim.mjs chat carol "!sr gatez"       # lands in the unresolved queue
node scripts/sim.mjs do collection.close '{"balanceNow":4500}'
node scripts/sim.mjs chat bob "!guess 6.5k"
node scripts/sim.mjs do guesses.lock
node scripts/sim.mjs do entry.setWin '{"entryId":"e2","win":900}'
node scripts/sim.mjs state
```

```bash
node scripts/sim.mjs new slot-tournament
node scripts/sim.mjs join 8                       # 8 viewers claim 8 real slots
node scripts/sim.mjs do join.close
node scripts/sim.mjs do draw.run
node scripts/sim.mjs do match.startVoting
node scripts/sim.mjs chat oracle "!vote a"
node scripts/sim.mjs do match.lockVoting
node scripts/sim.mjs do match.result '{"aBuyCost":100,"aPayout":425,"bBuyCost":200,"bPayout":610}'
```

`scripts/watch.mjs` connects to the overlay socket exactly as an OBS browser
source would and prints every frame — the opening snapshot, each patch and its
changed keys, the flash cues, and any gap it had to resync from. Run it in a
second terminal while you drive the simulator; it is the fastest way to see what
the overlay will actually receive.

```bash
node scripts/watch.mjs
```

`sim.mjs state` keeps working after a session ends — it falls back to rebuilding
from the event log, which is the same path the history screen uses.

---

## Layout

```
packages/
  shared/     wire protocol + DTOs shared with the UI
  core/       GameModule contract, effects, registry, guards, parser, primitives
  db/         Drizzle schema, SQL migrations, repositories
  kick/       OAuth PKCE, webhook verification, chat sender, subscriptions
  catalog/    slot resolution ladder + alias flywheel
  platform/   env, logger, Redis keys, queues, overlay bus, session cache
  games/
    bonus-hunt/
    slot-tournament/
apps/
  web/        Fastify: webhooks, OAuth, REST, WebSocket
  worker/     BullMQ consumers, router, effect executor, chat sender
```

`packages/games/*` may not import from `apps/*`. That single rule is what keeps game logic out of the runtime (§22).

---

## The pipeline (§10)

```
POST /webhooks/kick
  verify signature → dedupe on message id → enqueue → 200        apps/web/src/routes/webhooks.ts
    ↓
normalise Kick payload → internal event                          packages/kick/src/normalise.ts
route broadcaster → active session?  (one Redis GET)             apps/worker/src/router.ts
parse command      (one charAt before anything allocates)
guard              session → enabled → role → cooldown → caps    packages/core/src/guards.ts
    ↓
reduce   pure, no I/O, no Date.now(), no Math.random()           packages/games/*/src/reduce.ts
commit   append to session_events, project into Redis            apps/worker/src/session-runner.ts
execute  chat / broadcast / timer / lookup                       apps/worker/src/effect-executor.ts
```

Most webhook traffic dies at the route and parse steps, which is why they're the cheapest code in the system.

---

## API surface

All `/api/*` routes need the session cookie set by the OAuth callback. Errors are `{ error: { code, message, details? } }`.

### Auth

| | |
|---|---|
| `GET /auth/kick` | Starts OAuth 2.1 + PKCE. `?next=` for post-login redirect |
| `GET /auth/kick/callback` | Exchanges the code, stores encrypted tokens, sets the cookie |
| `POST /auth/logout` | Clears the cookie |
| `POST /auth/disconnect` | Revokes at Kick and deletes our copy. 409 while a session is running |

### Catalog and sessions

| | |
|---|---|
| `GET /api/games` | Playable games plus the "Soon" cards |
| `GET /api/games/:gameId/config` | Setup-form defaults: schema defaults ← saved channel config |
| `POST /api/sessions` | Create. Validates config against the game's Zod schema. 409 if one is already running |
| `GET /api/sessions` | History list + the four summary stat cards. `?gameId=&result=profit\|loss&limit=` |
| `GET /api/sessions/:id` | Config, projection, phase, overlay URL |
| `POST /api/sessions/:id/start` | Subscribes to Kick and emits `session.started` |
| `POST /api/sessions/:id/control` | **Every dashboard action.** `{ action, payload }` |
| `POST /api/sessions/:id/end` | `{ reason: 'complete' \| 'abandoned' }` |
| `GET /api/sessions/:id/analytics` | Worst slot, most requested, audience participation |
| `GET /api/sessions/:id/events` | The raw event log — "let me replay your session" (§11) |
| `GET /api/sessions/:id/export.csv` | Results table as CSV |
| `POST /api/sessions/:id/overlay-token` | Rotates the overlay URL |
| `GET /api/catalog/slots?q=` | Slot picker |
| `POST /api/catalog/slots/custom` | The never-block escape hatch (§21) |
| `POST /api/sessions/:id/resolve` | Unresolved queue: `{ entryId, slotId \| customName, rawText, action }` |

### Settings and admin

| | |
|---|---|
| `GET /api/me` | User, channel, scopes, active session |
| `GET`/`PUT /api/settings/:gameId` | Chat policy, command keywords, saved config |
| `POST /api/settings/overlay/regenerate` | Revoke a leaked overlay URL |
| `DELETE /api/settings/history` | Clear ended sessions |
| `DELETE /api/settings/account` | `{ confirm: true }`. Cascades |
| `GET`/`POST`/`PATCH`/`DELETE /api/admin/slots` | Catalog curation |
| `GET /api/admin/aliases/queue` | Review queue, highest hit-count first |
| `POST /api/admin/aliases/:id/approve\|reject` | Worked in bulk |
| `GET /api/admin/quota` | Daily deliveries per channel (§6.3) |
| `GET /api/admin/channels` | Flags channels holding subscriptions with no session |
| `GET /api/admin/health` | Queue depths, active sessions |

Admin routes are gated on `ADMIN_KICK_USER_IDS`.

### Control actions

**Bonus Hunt** — `entry.add`, `entry.remove`, `entry.resolve`, `entry.setBet`, `entry.markCollected`, `entry.uncollect`, `entry.setWin`, `entry.reorder`, `collection.close` (`{ balanceNow }`), `guesses.lock`, `hunt.complete`, `hunt.abandon`

**Slot Tournament** — `join.close`, `seats.set`, `reserve.add`/`reserve.remove`, `pool.resolve`, `pool.remove`, `draw.run`, `entrant.replace`, `match.startVoting`, `match.lockVoting`, `match.result` (`{ aBuyCost, aPayout, bBuyCost, bPayout }`), `match.revert`, `tournament.abandon`

### WebSocket

| | |
|---|---|
| `GET /ws/overlay/:token` | OBS browser source. Token-authenticated |
| `GET /ws/session/:id` | Dashboard. Cookie-authenticated, fuller state |

Server frames: `snapshot`, `patch`, `ended`, `pong`, `error`. Client frames: `ping`, `resync`.

On connect the server sends a full snapshot; after that, patches. Every frame carries two numbers:

- **`seq`** — which state version the client is now at.
- **`frame`** — a contiguous per-session frame counter. **Detect gaps on this, not on `seq`.**

They differ because plenty of events change nothing the overlay can see: a slot
lookup that fails to match moves `seq` without producing a patch. Watching `seq`
for gaps would make a busy hunt resync constantly and defeat patching entirely.

On a `frame` gap, send `{ t: 'resync' }` and the server replies with a full
snapshot. Patches merge shallowly by top-level key; `null` means the key was
removed.

---

## Bonus Hunt: entry states and the entry cap

An entry moves through four states, and the distinction between the middle two
is load-bearing — a streamer can play a slot and fail to trigger a bonus.

| status | meaning | UI badge |
|---|---|---|
| `pending` | the catalog hasn't matched the name (unresolved queue) | Pending |
| `queued` | matched, waiting for the streamer to play it | Pending |
| `collected` | the streamer banked the bonus — **this one counts** | Collected |
| `opened` | the win has been entered | — |

`entry.markCollected` is the "Mark Collected" button. `entry.uncollect` undoes a
misclick. Only `collected` and `opened` entries count toward `targetBonuses`,
`breakEvenPerBonus` and `spent` — counting suggestions would understate
break-even and claim bonuses that were never obtained.

The projection exposes both numbers: `collectedCount` (banked, for the progress
bar) and `suggestionCount` (everything, for the collecting list).

### `oneEntryPerViewer`

Controls how `maxEntriesPerViewer` is counted. **Off by default.**

| | meaning |
|---|---|
| `false` *(default)* | **outstanding** cap — a viewer may request again once the streamer has banked or dropped their last one |
| `true` | **lifetime** cap — one slot each for the whole hunt, however it goes |

Off by default because a channel with ten viewers cannot fill a thirty-bonus
hunt on one suggestion each, and the alternative — raising the cap outright —
lets one person take ten slots in the first minute.

An unresolved request still occupies the viewer's slot, so a typo can't be used
to queue endlessly.

Viewers change their pick with `!editsr <slot>` (aliases `!changesr`, `!swap`).
It swaps in place, keeping the entry's id, position and any bet already set, and
is refused once the list locks or the bonus has been opened.

---

## What the projections carry

`project()` feeds the overlay and never contains user ids. `projectDashboard()` adds the unresolved queue and the raw pool.

**Bonus Hunt** — `phase`, `entries[]` (with `thumbnail`, `multiplier`, `status`, `requestedBy`), `collectedCount`, `suggestionCount`, `breakEvenPerBonus`, `spent`, `won`, `profit`, `returnMultiple`, `toBreakEven`, `averageMultiplier`, `bestEntry`, `guessCount`, `participantCount`, `guessDistribution` (histogram buckets, lowest/median/highest, busiest bucket), `recentGuesses` (newest 25, with `edited`), `closestGuesses` (top 5 during opening), `guessWindowEndsAt`, `finalBalance`, `winner`.

**Slot Tournament** — `phase`, `seats`, `bracketSize`, `poolCount`, `entrants[]` (username above slot name, `source`, `hasBye`), `rounds[]` (structural, for the minimap), `currentMatch` with a live `split`, `votingEndsAt`, `leaderboard`, `champion`, `topPredictor`. Every decided match carries `decidedBy` — `multiplier`, `payout`, `cost`, `coinflip` or `bye` — because an unexplained winner on stream reads as broken software (§14).

Ephemeral cues arrive as explicit `broadcast` patches rather than state: `flash` (a win landed, guesses locked, votes locked), `drawReveal` (the seat-by-seat reveal order), `matchResult`, `inputError`.

---

## Decisions worth knowing

**Chat is quiet by default.** Ack mode defaults to errors-only (§15.1), so 300 viewers spamming `!sr` produce a handful of writes, not 300. Direct questions (`!hunt`, `!myslot`, `!score`) use a `reply` lane that survives errors-only, governed by their own rate limits instead.

**Announcements are held 12s.** The overlay is on the stream delay; chat isn't. Firing immediately spoils your own reveal (§15.3). Winner and game-result are always two messages, never merged.

**Subscriptions are session-scoped.** Created on start, deleted on end, reconciled on boot and every 15 minutes, and swept after 12 hours of silence. Inbound webhook volume is the binding constraint on the platform and it's charged per delivery whether or not anyone typed a command (§6.3).

**The draw runs once.** Seeded from the session seed, reproducible on replay, no re-roll anywhere. Seed numbers are assigned by a second seeded shuffle so byes don't systematically land on the streamer's hand-picked seats.

**Nothing lives only in Redis.** Wipe it and every session rebuilds from snapshot plus event log — `npm run test:smoke` asserts exactly that rather than assuming it.

**Replay refuses on a state-version mismatch.** A session written by an older shape of a game returns 409 rather than a plausible fiction.

---

## Deploying

Two processes, one image (§8). `Dockerfile` builds both; the command picks which
one runs:

```
node apps/web/dist/index.js      # HTTP, WebSocket, static dashboard + overlay
node apps/worker/dist/index.js   # game logic, Kick calls, timers, queues
```

They share Postgres and Redis. Neither talks to the other directly — the worker
publishes to Redis and the web fans out to sockets, so the web can scale on
connection count and the worker on queue depth, independently.

### Production refuses to start on a bad config

`NODE_ENV=production` turns on checks that would otherwise surface weeks later
as a broken OAuth redirect or a leaked session. All problems are reported at
once, at boot:

- `TOKEN_ENCRYPTION_KEY` still the all-zero placeholder
- `SESSION_SECRET` still the `change-me…` placeholder
- `PUBLIC_BASE_URL` not https, or still pointing at localhost
- `CORS_ORIGINS` containing `*`, a path, or a value that isn't a URL
- `KICK_WEBHOOK_ALLOW_UNSIGNED=true`

Generate the two secrets with:

```bash
node -e "console.log('TOKEN_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
```

`WEB_PORT` falls back to `PORT`, which Railway, Render and Fly inject.

### Railway

Four services in one project: **Postgres**, **Redis**, **web**, **worker**. Both
app services deploy from this repo and this Dockerfile — they differ only in
start command, which is why there are two config files:

| Service | Settings → Config-as-code path |
|---|---|
| web | *(none — Railway picks up `railway.json` at the root by itself)* |
| worker | `railway.worker.json` |

The web service needs no setting because Railway reads root `railway.json`
automatically. The worker is the one that has to be pointed elsewhere, or it
would inherit the web start command and run migrations a second time.

`railway.web.json` runs migrations as its pre-deploy command, so the schema is
applied once per release before the new container takes traffic. The worker has
no pre-deploy step — running migrations from two services races them.

Set on **both** app services (Railway's `${{...}}` references keep the
datastore URLs correct if a database is ever replaced):

```
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
TOKEN_ENCRYPTION_KEY=…
SESSION_SECRET=…
PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
KICK_CLIENT_ID=…
KICK_CLIENT_SECRET=…
KICK_REDIRECT_URI=https://${{RAILWAY_PUBLIC_DOMAIN}}/auth/kick/callback
```

`RAILWAY_PUBLIC_DOMAIN` resolves to whatever domain the web service has, which
avoids a chicken-and-egg: production refuses to boot on a localhost
`PUBLIC_BASE_URL`, but you don't know the real domain until the service exists.
Swap both for a custom domain once you attach one — and remember the Kick app's
redirect URI has to match exactly, so add the new one there at the same time.

The worker needs the Kick credentials too — it makes every outbound Kick call.

Then, once the web service has a domain:

1. Point `PUBLIC_BASE_URL` and `KICK_REDIRECT_URI` at it.
2. Add the same redirect URI to the Kick app.
3. Seed the slot catalog once: `railway run --service web node scripts/db.mjs seed`.

### Self-hosting

`docker-compose.prod.yml` runs the whole stack — datastores, migrations, web and
worker — from the built image. Also the quickest way to check a release locally
before pushing it:

```bash
docker compose -f docker-compose.prod.yml up --build
```

It reads `.env.prod` and overrides `DATABASE_URL`/`REDIS_URL` to the in-network
service names. It uses its own compose project name so its volumes never collide
with the development stack's.

### Cross-origin access

Denied by default. The dashboard, the overlay and the API are all served from
one origin, so nothing legitimate is cross-origin and `CORS_ORIGINS` is empty.

Two separate mechanisms, because they fail differently:

- **HTTP** — with no allowlist, no `Access-Control-Allow-Origin` is sent and
  browsers block cross-origin reads.
- **WebSocket** — CORS does not apply to WebSockets at all; the browser
  completes the upgrade regardless. The cookie-authenticated `/ws/session/:id`
  therefore checks `Origin` itself against the request's own `Host`, plus
  `PUBLIC_BASE_URL` and `CORS_ORIGINS`. Without it, any page could open a
  socket in a signed-in streamer's browser and read their live session.
  `/ws/overlay/:token` is exempt: it authenticates with an unguessable
  per-session token rather than a cookie, and OBS browser sources are not a
  reliable source of `Origin` headers.

Host is used rather than `PUBLIC_BASE_URL` alone because one deployment is
routinely reachable on several hostnames — a tunnel beside localhost in
development, apex beside www in production.

### Hosting the frontend somewhere else

`CORS_ORIGINS` on its own is **not enough** to run the dashboard on a different
domain from the API. The session cookie is `SameSite=Lax`, so a browser will not
send it on a cross-site request, and every authenticated call returns 401. A
split would need, at minimum:

1. The session cookie changed to `SameSite=None; Secure` in
   `apps/web/src/plugins/session.ts`.
2. The frontend origin in `CORS_ORIGINS`.
3. Real CSRF protection. `SameSite=Lax` is currently what stops a cross-site
   POST from carrying the cookie; `None` removes that, and the origin allowlist
   stops being defence-in-depth and becomes the only thing standing there.
4. The API origin baked into `apps/web/public/app.js`, which currently uses
   same-origin relative paths for both `fetch` and the WebSocket URL.

Worth knowing before taking that on: the frontend is eight static HTML files and
two ES modules with no build step, no bundler and no SSR. A static host adds a
second origin, the cookie work above and a CSRF surface, in exchange for serving
files that the API already serves. Keeping them on one origin is the reason auth
is as simple as it is.

---

## Not built

Per §26 and the build order in §23:

- **Fuzzy slot matching** is written and behind `CATALOG_FUZZY=false`. §21 ships exact and alias matching first, then tunes thresholds against real request data.
- **Follower gating** degrades to `anyone`. Kick doesn't put a follower badge on chat messages, so it needs a channel lookup that isn't wired yet; locking chat out on a guess would be worse.
- The `persist` effect has no consumer. The event log already holds everything either game needs.
