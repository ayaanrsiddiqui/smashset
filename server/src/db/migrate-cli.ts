// Standalone entry point for the schema, so CI (and a fresh local database)
// can be set up without booting the whole server. index.ts still runs the same
// runMigrations() at startup; this is the same work, on demand.
import '../env.js';
import { runMigrations } from './migrate.js';
import { pool } from './pool.js';

await runMigrations();
await pool.end();
console.log('[migrate] schema applied');
