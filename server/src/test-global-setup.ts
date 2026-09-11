import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './local-env.js';
import './env.js';
import { runner } from 'node-pg-migrate';
import { assertLocalDatabase } from './db/local-guard.js';

// Brings the test database up to the current schema before the suite runs, so
// a new migration can never leave tests passing against a stale one — and so
// there is no separate setup step to forget on a fresh clone or in CI.
export default async function setup(): Promise<void> {
  assertLocalDatabase('run migrations against', 'ALLOW_REMOTE_TEST_DB');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  await runner({
    databaseUrl: process.env.DATABASE_URL!,
    dir: path.resolve(__dirname, '../migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {}, // quiet: the suite's own output is what matters here
  });
}
