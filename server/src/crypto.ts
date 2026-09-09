import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // standard/recommended nonce length for GCM

const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
if (!keyHex) {
  throw new Error('TOKEN_ENCRYPTION_KEY is not set in .env');
}
const key = Buffer.from(keyHex, 'hex');
if (key.length !== 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, hex-encoded (64 chars) — generate one with `openssl rand -hex 32`');
}

/** Encrypts a string for storage. Format: `<iv>.<authTag>.<ciphertext>`, each hex-encoded. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${authTag.toString('hex')}.${ciphertext.toString('hex')}`;
}

/** Inverse of encrypt(). Throws if the payload was tampered with or the key doesn't match. */
export function decrypt(payload: string): string {
  const [ivHex, authTagHex, ciphertextHex] = payload.split('.');
  // Checked against `undefined` (a missing segment), not falsiness — an
  // empty *plaintext* legitimately encrypts to an empty ciphertext segment
  // (a real, if unlikely, value for these fields), which a truthiness check
  // would wrongly reject as malformed.
  if (ivHex === undefined || authTagHex === undefined || ciphertextHex === undefined) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
