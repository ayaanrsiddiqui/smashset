import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // Migrates the test database once before the suite, so tests can never run
    // against a schema older than the migrations in the tree.
    globalSetup: ['./src/test-global-setup.ts'],
    // Files run concurrently even though they share one database, because each
    // DB-backed file owns a disjoint slice of it: a timestamped startgg_user_id
    // PREFIX, and its own explicit player ids, with every DELETE scoped to
    // exactly those. Keep that contract when adding a file — a broad delete
    // (WHERE player_id < 0, say) would tear rows out from under another file,
    // which is what fileParallelism: false used to be hiding.
  },
});
