import { afterAll, describe, expect, it } from 'vitest';
import { pool } from './pool.js';
import { upsertUserFromOAuth } from './users.js';
import { createSession, getSessionWithUser, deleteSession, touchSessionExpiry, isPastHalfLife } from './sessions.js';
import { closeTestPool } from '../test-helpers.js';

const PREFIX = `test-sessions-${Date.now()}-`;
const idFor = (label: string) => `${PREFIX}${label}`;

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function makeTestUser(label: string) {
  return upsertUserFromOAuth(idFor(label), null, `Session Tester (${label})`, {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: futureDate(168),
  });
}

describe('db/sessions', () => {
  afterAll(async () => {
    // Deletes cascade from users -> sessions (ON DELETE CASCADE), so cleaning
    // up the test users is enough.
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('createSession then getSessionWithUser round-trips the correct, decrypted user', async () => {
    const user = await makeTestUser('roundtrip');
    const session = await createSession(user.id);

    const found = await getSessionWithUser(session.id);
    expect(found).not.toBeNull();
    expect(found?.sessionId).toBe(session.id);
    expect(found?.user.id).toBe(user.id);
    expect(found?.user.accessToken).toBe('access-roundtrip');
    expect(found?.user.refreshToken).toBe('refresh-roundtrip');
  });

  it('getSessionWithUser returns null for a session id that was never created', async () => {
    expect(await getSessionWithUser('this-session-id-does-not-exist')).toBeNull();
  });

  it('getSessionWithUser returns null for an expired session', async () => {
    const user = await makeTestUser('expired');
    // Insert directly with a past expiry — createSession() always sets a
    // 30-day future one, so this bypasses it to simulate an old session.
    const expiredId = `${PREFIX}expired-session-id`;
    await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
      expiredId,
      user.id,
      new Date(Date.now() - 1000),
    ]);

    expect(await getSessionWithUser(expiredId)).toBeNull();
  });

  it('deleteSession removes the row so it can no longer be found', async () => {
    const user = await makeTestUser('delete');
    const session = await createSession(user.id);
    expect(await getSessionWithUser(session.id)).not.toBeNull();

    await deleteSession(session.id);

    expect(await getSessionWithUser(session.id)).toBeNull();
  });

  it('deleteSession on a nonexistent id is a harmless no-op', async () => {
    await expect(deleteSession('never-existed')).resolves.toBeUndefined();
  });

  it('touchSessionExpiry extends the session forward from now', async () => {
    const user = await makeTestUser('touch');
    const session = await createSession(user.id);
    // Force it close to expiry so the extension is unambiguous.
    await pool.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [session.id, futureDate(1)]);

    const before = Date.now();
    const newExpiry = await touchSessionExpiry(session.id);
    expect(newExpiry.getTime()).toBeGreaterThan(before + 29 * 24 * 60 * 60 * 1000); // ~30 days out again

    const { rows } = await pool.query('SELECT expires_at FROM sessions WHERE id = $1', [session.id]);
    expect(new Date(rows[0].expires_at).getTime()).toBe(newExpiry.getTime());
  });

  describe('isPastHalfLife', () => {
    it('is true when less than half the 30-day TTL remains', () => {
      expect(isPastHalfLife(futureDate(24 * 10))).toBe(true); // 10 days left, half-life is 15
    });

    it('is false when more than half the TTL remains', () => {
      expect(isPastHalfLife(futureDate(24 * 25))).toBe(false); // 25 days left
    });

    it('is true for an already-expired timestamp', () => {
      expect(isPastHalfLife(new Date(Date.now() - 1000))).toBe(true);
    });
  });
});
