import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { pool } from './pool.js';
import { upsertUserFromOAuth } from './users.js';
import { createSession } from './sessions.js';
import { createAuthCode, redeemAuthCode } from './authCodes.js';
import { closeTestPool } from '../test-helpers.js';

const PREFIX = `test-auth-codes-${Date.now()}-`;

async function makeSession(label: string): Promise<string> {
  const user = await upsertUserFromOAuth(`${PREFIX}${label}`, null, `Auth Code Test (${label})`, {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: new Date(Date.now() + 168 * 60 * 60 * 1000),
  });
  const session = await createSession(user.id);
  return session.id;
}

afterEach(async () => {
  await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
});

afterAll(closeTestPool);

describe('redeemAuthCode', () => {
  it('returns the session the code was issued for', async () => {
    const sessionId = await makeSession('happy');
    const code = await createAuthCode(sessionId);

    const redeemed = await redeemAuthCode(code);

    expect(redeemed?.sessionId).toBe(sessionId);
    expect(redeemed?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a code that has already been spent', async () => {
    const sessionId = await makeSession('replay');
    const code = await createAuthCode(sessionId);

    expect(await redeemAuthCode(code)).not.toBeNull();
    // The whole point of the one-time code: someone who read it out of a
    // hijacked smashset:// redirect is holding something already spent.
    expect(await redeemAuthCode(code)).toBeNull();
  });

  it('refuses a code that has expired', async () => {
    const sessionId = await makeSession('expired');
    const code = await createAuthCode(sessionId);
    // Reaching past createAuthCode rather than faking the clock: expiry is
    // enforced by `expires_at > now()` inside Postgres, so it is Postgres's
    // clock that has to move, not the test process's.
    await pool.query(`UPDATE auth_codes SET expires_at = now() - interval '1 second' WHERE code = $1`, [code]);

    expect(await redeemAuthCode(code)).toBeNull();
  });

  it('refuses a code that was never issued', async () => {
    expect(await redeemAuthCode('not-a-real-code')).toBeNull();
  });

  it('leaves nothing behind once a code is spent', async () => {
    const sessionId = await makeSession('cleanup');
    const code = await createAuthCode(sessionId);
    await redeemAuthCode(code);

    const { rows } = await pool.query('SELECT 1 FROM auth_codes WHERE code = $1', [code]);
    expect(rows).toHaveLength(0);
  });

  it('does not outlive the session it points at', async () => {
    const sessionId = await makeSession('cascade');
    const code = await createAuthCode(sessionId);
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);

    // ON DELETE CASCADE: a signed-out session must not leave a live code that
    // would hand someone a seat that no longer exists.
    expect(await redeemAuthCode(code)).toBeNull();
  });
});
