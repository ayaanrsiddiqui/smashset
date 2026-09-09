// Loads and validates the same env vars real boot uses (see env.ts's own
// comment on why this ordering matters) — runs before any test file via
// vitest's setupFiles, so pool.ts/crypto.ts see a populated process.env.
import './env.js';
