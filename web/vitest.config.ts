import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // shared/ sits beside web/ and server/, outside this package's root, and
  // Vite refuses to serve files outside it by default. Only the test runner
  // needs this; the production build never reaches for the fixture.
  server: { fs: { allow: ['..'] } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
  },
});
