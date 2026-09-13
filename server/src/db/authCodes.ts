import { randomBytes } from 'crypto';
import { pool } from './pool.js';

// Long enough that the app can be backgrounded by the sign-in sheet dismissing
// and still redeem, short enough that a code read out of a hijacked custom-URL
// redirect is stale before anyone could use it.
const CODE_TTL_MS = 60_000;

export async function createAuthCode(sessionId: string): Promise<string> {
  const code = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO auth_codes (code, session_id, expires_at) VALUES ($1, $2, $3)', [
    code,
    sessionId,
    new Date(Date.now() + CODE_TTL_MS),
  ]);
  return code;
}

export interface RedeemedCode {
  sessionId: string;
  expiresAt: Date;
}

/**
 * Spends a code and returns the session it stood for, or null if it was
 * already spent, has expired, or never existed.
 *
 * Deleting *is* the single-use check, and it is one statement rather than a
 * read and then a write: two requests carrying the same code would both clear
 * a separate SELECT before either UPDATE landed, and both would be handed the
 * session. Here exactly one of them deletes a row, so exactly one gets a
 * result — and a spent code leaves nothing behind to leak.
 */
export async function redeemAuthCode(code: string): Promise<RedeemedCode | null> {
  const { rows } = await pool.query<{ session_id: string; expires_at: Date }>(
    `DELETE FROM auth_codes
     USING sessions
     WHERE auth_codes.code = $1
       AND auth_codes.expires_at > now()
       AND sessions.id = auth_codes.session_id
     RETURNING auth_codes.session_id, sessions.expires_at`,
    [code]
  );
  const row = rows[0];
  return row ? { sessionId: row.session_id, expiresAt: row.expires_at } : null;
}
