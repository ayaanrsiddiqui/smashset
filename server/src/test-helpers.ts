import { pool } from './db/pool.js';

// Every DB-backed test file closes the shared pool in its own afterAll so
// the process can exit cleanly (an open pg.Pool keeps the event loop alive
// indefinitely). Despite fileParallelism:false, vitest doesn't guarantee
// these files share zero state — in practice a later file has hit "pool
// already ended" from an earlier one's cleanup — so this just swallows
// that one specific, harmless race instead of relying on execution order.
export async function closeTestPool(): Promise<void> {
  try {
    await pool.end();
  } catch (err) {
    if (err instanceof Error && err.message.includes('Cannot use a pool after calling end')) return;
    throw err;
  }
}
