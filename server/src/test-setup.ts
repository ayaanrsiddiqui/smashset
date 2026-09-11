// Loads and validates the same env vars real boot uses (see env.ts's own
// comment on why this ordering matters) — runs before any test file via
// vitest's setupFiles, so pool.ts/crypto.ts see a populated process.env.
// test-env.js comes first so a local test database can override DATABASE_URL.
import './local-env.js';
import './env.js';

// These tests DELETE rows, and once ran against the production database —
// which was survivable only because every cleanup was narrowly scoped, one
// careless WHERE clause away from real tournament data. See .env.test.example.
import { assertLocalDatabase } from './db/local-guard.js';

assertLocalDatabase('run the test suite against', 'ALLOW_REMOTE_TEST_DB');
