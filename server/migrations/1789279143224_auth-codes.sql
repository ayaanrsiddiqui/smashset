-- Up Migration

-- One-time codes that hand a freshly created session to a native client.
--
-- The iOS callback cannot be given a cookie, and iOS does not enforce
-- uniqueness on custom URL schemes: another app can register smashset:// and
-- receive the redirect. So nothing durable travels in that URL. This code
-- does, it dies in a minute, and it can only be spent once — for the real
-- session id, over HTTPS.
CREATE TABLE IF NOT EXISTS auth_codes (
  code       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_codes_expires_at_idx ON auth_codes(expires_at);

-- Down Migration

-- Safe to drop, unlike the baseline: a code is worthless a minute after it is
-- issued, so nothing here outlives a rollback that anyone would care about.
DROP TABLE IF EXISTS auth_codes;
