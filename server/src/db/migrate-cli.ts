// Applies pending migrations. This is the only thing that touches the schema:
// the server no longer migrates at boot, so a deploy that cannot migrate fails
// before it serves traffic instead of starting against a schema it disagrees
// with, and multiple replicas can't race each other to alter the same tables.
//
// Run via `npm run migrate` (tsx, for local and CI) or `npm run migrate:prod`
// (compiled, for Railway's pre-deploy command).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Before env.js, so a local .env.test wins over the .env that points at
// production — the same precedence the test setup relies on.
import '../local-env.js';
import '../env.js';
import { runner } from 'node-pg-migrate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/db and dist/db are both one level under server/, so this resolves to
// server/migrations whether it runs from source or from the build.
const dir = path.resolve(__dirname, '../../migrations');

const databaseUrl = process.env.DATABASE_URL!;
const host = new URL(databaseUrl).hostname;
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host);

// Migrating the wrong database is the expensive mistake here, and .env points
// at production, so targeting anything remote has to be said out loud. Railway's
// pre-deploy command sets ALLOW_REMOTE_MIGRATE=1 precisely because that deploy
// does mean production.
if (!isLocal && process.env.ALLOW_REMOTE_MIGRATE !== '1') {
  console.error(
    `Refusing to migrate a non-local database (${host}).\n` +
      `Set a local DATABASE_URL (see .env.test.example), or set\n` +
      `ALLOW_REMOTE_MIGRATE=1 if you genuinely mean to migrate ${host}.`
  );
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
