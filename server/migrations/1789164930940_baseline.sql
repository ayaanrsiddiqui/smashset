-- Baseline: the schema as it stood when migrations were introduced, lifted
-- verbatim from the boot-time runMigrations() this replaces.
--
-- Every statement is idempotent so that applying it to the already-deployed
-- production database is a no-op, and applying it to a fresh one (CI, a local
-- test database) builds the whole schema. That is what lets this be adopted
-- without a separate "mark as already applied" step against production.

-- Up Migration

CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  startgg_user_id  TEXT NOT NULL UNIQUE,
  startgg_slug     TEXT,
  display_name     TEXT NOT NULL,
  access_token     TEXT NOT NULL,
  refresh_token    TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  top_x_bo5        INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS player_mains (
  player_id       INTEGER NOT NULL,
  videogame_id    INTEGER NOT NULL,
  character_id    INTEGER,
  games_tallied   INTEGER NOT NULL DEFAULT 0,
  sets_considered INTEGER NOT NULL DEFAULT 0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, videogame_id)
);

-- CREATE TABLE IF NOT EXISTS is a no-op against a users table that already
-- exists (the deployed one, pre-dating top_x_bo5), so the column needs its
-- own idempotent statement to actually reach it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS top_x_bo5 INTEGER;

-- Down Migration

-- Deliberately empty. Rolling back past the baseline would mean dropping every
-- table in the database, including live tournament data; that should be a
-- considered act with a backup in hand, not one command away.
