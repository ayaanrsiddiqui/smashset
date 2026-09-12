import { afterAll, describe, expect, it } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';
import { testServer } from '../test-server.js';
import { createApp } from '../app.js';

const server = testServer(createApp());

const PREFIX = `test-account-route-${Date.now()}-`;
const idFor = (label: string) => `${PREFIX}${label}`;

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function makeSignedInCookie(label: string, startggSlug: string | null = null): Promise<string> {
  const user = await upsertUserFromOAuth(idFor(label), startggSlug, `Account Route Test (${label})`, {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: futureDate(168),
  });
  const session = await createSession(user.id);
  const signed = `s:${sign(session.id, process.env.SESSION_SECRET!)}`;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

describe('GET/POST /api/account', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(server).get('/api/account');
    expect(res.status).toBe(401);
  });

  it('returns the signed-in user\'s display name, slug, and default (unset) preference', async () => {
    const cookie = await makeSignedInCookie('get', 'user/abc');
    const res = await request(server).get('/api/account').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Account Route Test (get)');
    expect(res.body.startggSlug).toBe('user/abc');
    expect(res.body.topXBo5).toBeNull();
  });

  it('sets the preference and reflects it back on the next GET', async () => {
    const cookie = await makeSignedInCookie('set-pref');

    const postRes = await request(server).post('/api/account/preferences').set('Cookie', cookie).send({ topXBo5: 9 });
    expect(postRes.status).toBe(200);
    expect(postRes.body.topXBo5).toBe(9);

    const getRes = await request(server).get('/api/account').set('Cookie', cookie);
    expect(getRes.body.topXBo5).toBe(9);
  });

  it('clears the preference when sent null', async () => {
    const cookie = await makeSignedInCookie('clear-pref');
    await request(server).post('/api/account/preferences').set('Cookie', cookie).send({ topXBo5: 4 });

    const clearRes = await request(server).post('/api/account/preferences').set('Cookie', cookie).send({ topXBo5: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.topXBo5).toBeNull();
  });

  it('rejects a non-positive or non-integer topXBo5', async () => {
    const cookie = await makeSignedInCookie('reject-pref');
    for (const bad of [0, -3, 1.5, 'nine']) {
      const res = await request(server).post('/api/account/preferences').set('Cookie', cookie).send({ topXBo5: bad });
      expect(res.status).toBe(400);
    }
  });
});
