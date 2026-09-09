import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
const apiPort = process.env.API_PORT ? Number(process.env.API_PORT) : 3001

export default defineConfig({
  plugins: [react()],
  server: {
    // Explicit 127.0.0.1, not the default (which can end up bound to the
    // IPv6 loopback only) — the OAuth session cookie is set on 127.0.0.1
    // (start.gg's app registration rejects "localhost" as a redirect host),
    // and cookies are scoped by the literal hostname string, not the
    // resolved address, so "localhost" and "127.0.0.1" don't share cookies
    // even though both mean the same loopback interface.
    host: '127.0.0.1',
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
})
