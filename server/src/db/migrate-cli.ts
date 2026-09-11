// Applies pending migrations. This is the only thing that touches the schema:
// the server no longer migrates at boot, so a deploy that cannot migrate fails
// before it serves traffic instead of starting against a schema it disagrees
// with, and multiple replicas can't race each other to alter the same tables.
//
// Follows DATABASE_URL, which means `.env` — the local development database.
// The test database is migrated on its own by the vitest global setup, and
// production by Railway's pre-deploy command running `npm run migrate:prod`.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../env.js';
import { runner } from 'node-pg-migrate';
import { assertLocalDatabase } from './local-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/db and dist/db are both one level under server/, so this resolves to
// server/migrations whether it runs from source or from the build.
const dir = path.resolve(__dirname, '../../migrations');

const databaseUrl = process.env.DATABASE_URL!;
const host = new URL(databaseUrl).hostname;

try {
  assertLocalDatabase('migrate', 'ALLOW_REMOTE_MIGRATE');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const down = process.argv.includes('down');

// Always say which database is about to change, before changing it.
console.log(`[migrate] target ${host} — ${down ? 'rolling back one migration' : 'applying pending migrations'}`);

const applied = await runner({
  databaseUrl,
  dir,
  direction: down ? 'down' : 'up',
  // Down is one step at a time on purpose — a rollback should be a deliberate,
  // observable move rather than unwinding the whole history in one command.
  count: down ? 1 : Infinity,
  migrationsTable: 'pgmigrations',
  log: (msg) => console.log(`[migrate] ${msg}`),
});

console.log(applied.length ? `[migrate] applied ${applied.length}` : '[migrate] already up to date');
