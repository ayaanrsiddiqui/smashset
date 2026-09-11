// Loads and validates the same env vars real boot uses (see env.ts's own
// comment on why this ordering matters) — runs before any test file via
// vitest's setupFiles, so pool.ts/crypto.ts see a populated process.env.
// test-env.js comes first so a local test database can override DATABASE_URL.
import './test-env.js';
import './env.js';

// These tests DELETE rows. They used to run against the production database,
// which worked only because every cleanup was narrowly scoped — one careless
// WHERE clause away from deleting real tournament data. Point DATABASE_URL at
// a throwaway database instead; see .env.test.example.
const host = new URL(process.env.DATABASE_URL!).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
  throw new Error(
    `Refusing to run the test suite against a non-local database (${host}).\n` +
      `The suite writes and deletes rows, so it needs a disposable database.\n` +
      `Copy .env.test.example to .env.test and point it at a local one, or set\n` +
      `ALLOW_REMOTE_TEST_DB=1 if you genuinely mean to target ${host}.`
  );
}
