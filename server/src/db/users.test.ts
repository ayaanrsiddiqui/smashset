import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from './pool.js';
import { getUserById, getUserByStartggId, upsertUserFromOAuth, updateUserTokens, updateUserTopXBo5 } from './users.js';
import { closeTestPool } from '../test-helpers.js';

// Every row this file creates is scoped under this prefix and swept up in
// afterAll — real user data (e.g. the actual FireSlam23 account) lives under
// a plain numeric startgg_user_id and is never touched.
const PREFIX = `test-users-${Date.now()}-`;
const idFor = (label: string) => `${PREFIX}${label}`;

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

describe('db/users', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('upsertUserFromOAuth inserts a new user and encrypts tokens at rest', async () => {
    const startggId = idFor('insert');
    const user = await upsertUserFromOAuth(startggId, 'user/abc', 'Tester', {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: futureDate(168),
    });

    expect(user.startggUserId).toBe(startggId);
    expect(user.startggSlug).toBe('user/abc');
    expect(user.displayName).toBe('Tester');
    expect(user.accessToken).toBe('access-1');
    expect(user.refreshToken).toBe('refresh-1');

    const { rows } = await pool.query('SELECT access_token, refresh_token FROM users WHERE startgg_user_id = $1', [
      startggId,
    ]);
    expect(rows[0].access_token).not.toBe('access-1'); // stored encrypted, not plaintext
    expect(rows[0].access_token).toMatch(/^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/);
  });

  it('upsertUserFromOAuth on an existing startgg_user_id updates in place rather than duplicating', async () => {
    const startggId = idFor('upsert-twice');
    const first = await upsertUserFromOAuth(startggId, 'user/v1', 'Name V1', {
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: futureDate(168),
    });
    const second = await upsertUserFromOAuth(startggId, 'user/v2', 'Name V2', {
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: futureDate(168),
    });

    expect(second.id).toBe(first.id); // same row, not a new one
    expect(second.displayName).toBe('Name V2');
    expect(second.accessToken).toBe('a2');

    const { rows } = await pool.query('SELECT count(*) FROM users WHERE startgg_user_id = $1', [startggId]);
    expect(Number(rows[0].count)).toBe(1);
  });

  it('getUserById and getUserByStartggId return matching, decrypted data', async () => {
    const startggId = idFor('lookup');
    const created = await upsertUserFromOAuth(startggId, null, 'Lookup Tester', {
      accessToken: 'look-access',
      refreshToken: 'look-refresh',
      expiresAt: futureDate(168),
    });

    const byId = await getUserById(created.id);
    const byStartggId = await getUserByStartggId(startggId);

    expect(byId).toEqual(created);
    expect(byStartggId).toEqual(created);
  });

  it('getUserById and getUserByStartggId return null for a nonexistent user', async () => {
    expect(await getUserById(-1)).toBeNull();
    expect(await getUserByStartggId(idFor('does-not-exist'))).toBeNull();
  });

  it('updateUserTokens overwrites the stored tokens and expiry', async () => {
    const startggId = idFor('update-tokens');
    const created = await upsertUserFromOAuth(startggId, null, 'Refresh Tester', {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: futureDate(1),
    });

    const newExpiry = futureDate(168);
    await updateUserTokens(created.id, {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: newExpiry,
    });

    const updated = await getUserById(created.id);
    expect(updated?.accessToken).toBe('new-access');
    expect(updated?.refreshToken).toBe('new-refresh');
    expect(updated?.tokenExpiresAt.getTime()).toBe(newExpiry.getTime());
  });

  it('a new user has no topXBo5 preference until one is set', async () => {
    const created = await upsertUserFromOAuth(idFor('default-topx'), null, 'Default TopX Tester', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: futureDate(168),
    });
    expect(created.topXBo5).toBeNull();
  });

  it('updateUserTopXBo5 sets, overwrites, and clears the preference', async () => {
    const created = await upsertUserFromOAuth(idFor('update-topx'), null, 'TopX Tester', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: futureDate(168),
    });

    const setTo17 = await updateUserTopXBo5(created.id, 17);
    expect(setTo17?.topXBo5).toBe(17);
    expect((await getUserById(created.id))?.topXBo5).toBe(17);

    const overwritten = await updateUserTopXBo5(created.id, 33);
    expect(overwritten?.topXBo5).toBe(33);

    const cleared = await updateUserTopXBo5(created.id, null);
    expect(cleared?.topXBo5).toBeNull();
  });

  it('updateUserTopXBo5 returns null for a nonexistent user', async () => {
    expect(await updateUserTopXBo5(-1, 5)).toBeNull();
  });
});
