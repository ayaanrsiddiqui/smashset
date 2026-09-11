import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Must be imported BEFORE ./env.js — sibling static imports evaluate in source
// order, the same hoisting rule env.ts documents for itself. dotenv never
// overwrites an already-set variable, so anything .env.test defines here wins
// over .env afterwards. That is what keeps `npm test` off the production
// database without needing a second copy of every other secret.
//
// CI sets DATABASE_URL as a real environment variable, which beats both files,
// so no .env.test is needed there.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });
