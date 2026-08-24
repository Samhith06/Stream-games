-- Team Battles §10 — the catalog learns what a bonus buy costs.
--
-- The spec calls this "the only upstream dependency in this spec", and it is
-- needed at !join time rather than at buy time: an entry whose buy is outside
-- the session's bounds has to be rejected in front of the viewer who typed it,
-- not discovered when the streamer opens the slot forty minutes later.
--
-- Both columns are nullable on purpose. The catalog holds ~6,300 slots imported
-- from slot.report and almost none of them carry buy data, so a NOT NULL column
-- would either need a fabricated default — which would then be enforced as if
-- it were a fact — or would block the import outright. Null means "we don't
-- know", and §10's guards are written to treat not-knowing as its own case
-- rather than folding it into pass or fail.

-- Buy cost as a multiple of bet, which is how every slot quotes it and the only
-- form comparable across stake levels. 100x means a €1 bet buys for €100.
ALTER TABLE slots ADD COLUMN buy_cost_x NUMERIC(8, 2);

-- Tri-state, deliberately: true, false, and null for unknown. A slot with no
-- buy feature at all cannot be entered into a Team Battles session, but that
-- must be something we established rather than something we assumed.
ALTER TABLE slots ADD COLUMN has_bonus_buy BOOLEAN;

-- The guard filters on this range, so an index pays for itself the moment a
-- streamer runs a session with bounds set.
CREATE INDEX slots_buy_cost_idx ON slots(buy_cost_x) WHERE buy_cost_x IS NOT NULL;
