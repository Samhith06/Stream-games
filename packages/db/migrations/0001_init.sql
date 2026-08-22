-- StreamArena initial schema — §11 of the master spec.
-- Postgres is the source of truth. Redis holds nothing that isn't rebuildable
-- from here.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- Powers the trigram ladder in §21 step 3. Layered in behind the same
-- interface as exact matching, so it can be enabled without code changes.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Identity ───────────────────────────────────────────────────────────────

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kick_user_id   TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  avatar_url     TEXT,
  email          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens are encrypted at rest (§12). A leaked refresh token lets
-- someone post as the streamer; it is treated like a password.
CREATE TABLE oauth_tokens (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  scopes         TEXT[] NOT NULL DEFAULT '{}',
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcaster_user_id  TEXT NOT NULL UNIQUE,
  slug                 TEXT NOT NULL,
  owner_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channels_owner_idx ON channels(owner_user_id);

-- ─── Sessions ───────────────────────────────────────────────────────────────

CREATE TABLE game_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  game_id        TEXT NOT NULL,
  state_version  INTEGER NOT NULL,
  -- Every draw and coin flip derives from this. Stored so a replay reproduces
  -- the same champion (§9).
  seed           TEXT NOT NULL,
  config         JSONB NOT NULL DEFAULT '{}'::jsonb,
  chat_policy    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'created'
                   CHECK (status IN ('created','running','ended','abandoned')),
  phase          TEXT,
  -- Per-session token so an overlay URL leak can be revoked without touching
  -- the streamer's Kick credentials (§25).
  overlay_token  TEXT NOT NULL UNIQUE,
  last_seq       BIGINT NOT NULL DEFAULT 0,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX game_sessions_channel_idx ON game_sessions(channel_id, created_at DESC);
-- Step 3 of the pipeline resolves broadcaster -> active session. Redis serves
-- the hot path; this partial index makes the cold path and boot reconcile fast.
CREATE UNIQUE INDEX game_sessions_one_active_per_channel
  ON game_sessions(channel_id)
  WHERE status IN ('created','running');

-- The log is the source of truth (§10 step 7). Append only.
CREATE TABLE session_events (
  id               BIGSERIAL PRIMARY KEY,
  session_id       UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  seq              BIGINT NOT NULL,
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  -- Idempotency: a redelivered webhook can never append a second event.
  kick_message_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_events_seq_unique UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX session_events_kick_message_unique
  ON session_events(session_id, kick_message_id)
  WHERE kick_message_id IS NOT NULL;
CREATE INDEX session_events_replay_idx ON session_events(session_id, seq);

-- Every N events, so replay isn't O(all events) (§11).
CREATE TABLE session_snapshots (
  id             BIGSERIAL PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  seq            BIGINT NOT NULL,
  state_version  INTEGER NOT NULL,
  state          JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_snapshots_seq_unique UNIQUE (session_id, seq)
);
CREATE INDEX session_snapshots_latest_idx ON session_snapshots(session_id, seq DESC);

-- Per-channel game settings and keyword overrides (§9, §15.1).
CREATE TABLE game_configs (
  channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  game_id      TEXT NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  commands     JSONB NOT NULL DEFAULT '{}'::jsonb,
  chat_policy  JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, game_id)
);

-- ─── Slot catalog (§21) ─────────────────────────────────────────────────────

CREATE TABLE slots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  -- Lowercased, punctuation stripped. Step 1 of the resolution ladder.
  normalised   TEXT NOT NULL,
  provider     TEXT,
  rtp          NUMERIC(5,2),
  max_win      INTEGER,
  volatility   TEXT,
  thumbnail    TEXT,
  -- Free-text slots created from the "Add as custom slot" escape hatch, so a
  -- missing catalog entry can never stop a hunt mid-stream (§21).
  is_custom    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX slots_normalised_unique ON slots(normalised) WHERE is_custom = false;
CREATE INDEX slots_trgm_idx ON slots USING gin (normalised gin_trgm_ops);
CREATE INDEX slots_provider_idx ON slots(provider);

-- The alias flywheel (§21). Every unresolved-queue decision writes a learned
-- alias; frequency across channels raises its weight.
CREATE TABLE slot_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id     UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  normalised  TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','learned')),
  weight      REAL NOT NULL DEFAULT 1,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  approved    BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX slot_aliases_unique ON slot_aliases(normalised, slot_id);
CREATE INDEX slot_aliases_lookup_idx ON slot_aliases(normalised) WHERE approved = true;
CREATE INDEX slot_aliases_trgm_idx ON slot_aliases USING gin (normalised gin_trgm_ops);
-- Admin alias review queue, sorted by frequency so the highest-impact fixes
-- come first (§21).
CREATE INDEX slot_aliases_review_idx ON slot_aliases(hit_count DESC) WHERE approved = false;

-- ─── Quota telemetry (§6.3) ─────────────────────────────────────────────────
-- The binding constraint on the whole platform is inbound webhook volume, and
-- Kick publishes no numbers. Watch the ceiling approach rather than discovering
-- it mid-stream.

CREATE TABLE webhook_quota_daily (
  day           DATE NOT NULL,
  channel_id    UUID REFERENCES channels(id) ON DELETE CASCADE,
  deliveries    BIGINT NOT NULL DEFAULT 0,
  commands      BIGINT NOT NULL DEFAULT 0,
  dropped       BIGINT NOT NULL DEFAULT 0,
  chat_writes   BIGINT NOT NULL DEFAULT 0,
  chat_failures BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, channel_id)
);

-- Session-scoped subscriptions (§6.3). Reconciled against Kick on boot so
-- orphans from a crashed worker get dropped rather than burning quota forever.
CREATE TABLE kick_subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id           UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id           UUID REFERENCES game_sessions(id) ON DELETE SET NULL,
  kick_subscription_id TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX kick_subscriptions_remote_unique ON kick_subscriptions(kick_subscription_id);
CREATE INDEX kick_subscriptions_active_idx ON kick_subscriptions(channel_id) WHERE deleted_at IS NULL;
