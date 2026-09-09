import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // DB-backed tests share one real Postgres instance (Railway) — no
    // isolation between parallel workers, so run them one file at a time.
    fileParallelism: false,
  },
});
