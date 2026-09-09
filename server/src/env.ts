import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// This must be the FIRST thing that runs, before pool.ts/crypto.ts (or
// anything else that reads process.env at module load time) ever gets
// evaluated. Static `import`s evaluate their target module's top-level code
// before the importing file's own code runs, in source order for sibling
// imports — so as long as `import './env.js'` is the first import line in
// index.ts, this file's dotenv.config() call below is guaranteed to run
// before any later-imported module (routes/auth.js -> db/pool.js, etc.) is
// evaluated. Putting dotenv.config() inline in index.ts's own body, after
// its imports, does NOT work for this — it would run after those modules
// already tried (and failed) to read their env vars.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED_VARS = [
  'STARTGG_OAUTH_CLIENT_ID',
  'STARTGG_OAUTH_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'DATABASE_URL',
  'APP_BASE_URL',
] as const;

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
}

// In production this process serves the frontend itself (same origin as
// APP_BASE_URL), so FRONTEND_URL is ignored there even if something left it
// set — a stray dev value in prod config would otherwise silently redirect
// every login to a dead local port instead of the real deployed app. In dev,
// Vite (the actual app) and Express (where the OAuth redirect_uri must land)
// run on different origins, so FRONTEND_URL is what points back to Vite.
export const FRONTEND_URL =
  process.env.NODE_ENV === 'production' ? process.env.APP_BASE_URL! : (process.env.FRONTEND_URL ?? process.env.APP_BASE_URL!);

// start.gg ties an OAuth app to its redirect URI, so the local dev app
// (127.0.0.1:3001 callback) and the deployed prod app (the Railway domain's
// callback) are two separate apps and can't share credentials. Production
// sets only the plain names below; DEV_-prefixed vars hold the dev app's
// credentials so both can live in the same local .env without colliding.
export const STARTGG_OAUTH_CLIENT_ID =
  process.env.NODE_ENV === 'production'
    ? process.env.STARTGG_OAUTH_CLIENT_ID!
    : (process.env.DEV_STARTGG_OAUTH_CLIENT_ID ?? process.env.STARTGG_OAUTH_CLIENT_ID!);
export const STARTGG_OAUTH_CLIENT_SECRET =
  process.env.NODE_ENV === 'production'
    ? process.env.STARTGG_OAUTH_CLIENT_SECRET!
    : (process.env.DEV_STARTGG_OAUTH_CLIENT_SECRET ?? process.env.STARTGG_OAUTH_CLIENT_SECRET!);
