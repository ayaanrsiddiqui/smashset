-- Up Migration

-- Every set smashset reported, recorded by the server at the moment start.gg
-- confirmed it. Until now the only trace was a `report-delivered` line from the
-- client beacon: fire-and-forget over venue wifi, unauthenticated, and kept by
-- Railway for days. On Bring More Setups 218 the logs held 6 of a Melee
-- bracket's 58 sets, which says far more about the beacon than about the
-- night.
--
-- One row per confirmed outcome, not per set. A TO correcting a score writes a
-- second row, and so does an outbox retry that finds its first attempt already
-- landed — that retry is the only record if the server died between start.gg
-- confirming and the row being written. Totals therefore count distinct
-- set_id, and attempt/already_on_file are kept so retries can be seen rather
-- than silently inflating anything.
--
-- External ids are TEXT: start.gg's are numeric, but a set reported off an
-- unstarted bracket is "preview_…" until it materialises.
CREATE TABLE IF NOT EXISTS set_reports (
  id                     SERIAL PRIMARY KEY,
  set_id                 TEXT NOT NULL,
  -- Read from start.gg by the server, never from the request body, where the
  -- route treats phaseGroupId as an untrusted notification hint.
  phase_group_id         TEXT NOT NULL,
  -- SET NULL so deleting an account drops who reported a set, not that it was
  -- reported. Brackets are public; the link to a person is the private part.
  user_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  winner_entrant_id      TEXT,
  loser_entrant_id       TEXT,
  games                  INTEGER,
  -- Games with a character entered for each side, out of `games`. Counts
  -- rather than a yes/no so "with characters" can mean every game or any game
  -- without having to re-collect.
  winner_character_games INTEGER,
  loser_character_games  INTEGER,
  attempt                INTEGER,
  already_on_file        BOOLEAN NOT NULL DEFAULT false,
  -- Panel opened to report pressed, measured in the browser. The claim being
  -- tested is 15-20s down to 5-10s, so read it as a median.
  open_to_report_ms      INTEGER CHECK (open_to_report_ms IS NULL OR open_to_report_ms >= 0),
  -- Report pressed to start.gg confirming: time spent in the outbox plus the
  -- server's own handling. A separate number from the one above.
  delivery_ms            INTEGER CHECK (delivery_ms IS NULL OR delivery_ms >= 0),
  -- 'log' rows were recovered from Railway after the fact and carry no
  -- timings or characters: the beacon never had them.
  source                 TEXT NOT NULL DEFAULT 'server' CHECK (source IN ('server', 'log')),
  reported_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS set_reports_phase_group_idx ON set_reports(phase_group_id);
CREATE INDEX IF NOT EXISTS set_reports_reported_at_idx ON set_reports(reported_at);

-- One row per bracket a report has touched: what to call it, and how many sets
-- it has, so a dashboard can say "reported 34 of 58" without asking start.gg.
-- total_sets is null until it has been counted. Zero is never stored: a bracket
-- started from smashset hides its sets for about forty seconds after
-- materialising, and a 0 recorded in that window would read as a fact.
CREATE TABLE IF NOT EXISTS report_brackets (
  phase_group_id     TEXT PRIMARY KEY,
  display_identifier TEXT,
  phase_name         TEXT,
  event_id           TEXT,
  event_name         TEXT,
  tournament_id      TEXT,
  tournament_name    TEXT,
  tournament_slug    TEXT,
  total_sets         INTEGER CHECK (total_sets IS NULL OR total_sets > 0),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

-- Destroys every recorded report. Unlike the derived caches elsewhere in this
-- schema, nothing can recompute these rows: once dropped, the history of what
-- smashset reported is gone. Only roll this back on purpose.
DROP TABLE IF EXISTS set_reports;
DROP TABLE IF EXISTS report_brackets;
