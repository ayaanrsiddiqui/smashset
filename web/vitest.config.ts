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
    // The palette guard reads index.css with ?raw. Left off (the default),
    // vitest stubs every CSS import to an empty string and the guard passes
    // having checked nothing. Costs about half a second across the suite.
    css: true,
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
  },
});
