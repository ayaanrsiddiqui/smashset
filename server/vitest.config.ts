import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // Migrates the test database once before the suite, so tests can never run
    // against a schema older than the migrations in the tree.
    globalSetup: ['./src/test-global-setup.ts'],
    // DB-backed test files share one database, so they'd contend for the same
    // rows if run concurrently. One file at a time.
    fileParallelism: false,
  },
});
