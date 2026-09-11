import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Must be imported BEFORE ./env.js — sibling static imports evaluate in source
// order, the same hoisting rule env.ts documents for itself. dotenv never
// overwrites an already-set variable, so anything .env.test defines here wins
// over .env afterwards.
//
// .env points at the production database, so this is what keeps local `npm
// test` and local `npm run migrate` off it by default. In CI and on Railway,
// DATABASE_URL is a real environment variable, which beats both files.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });
