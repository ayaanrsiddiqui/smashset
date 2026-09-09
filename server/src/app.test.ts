import { afterAll, describe, expect, it } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from './db/pool.js';
import { upsertUserFromOAuth } from './db/users.js';
import { createSession } from './db/sessions.js';
import { createApp } from './app.js';
import { SESSION_COOKIE_NAME } from './middleware/auth.js';
import { closeTestPool } from './test-helpers.js';

const PREFIX = `test-app-${Date.now()}-`;
const idFor = (label: string) => `${PREFIX}${label}`;
const app = createApp();

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function makeSignedInCookie(label: string): Promise<string> {
  const user = await upsertUserFromOAuth(idFor(label), null, `App Test (${label})`, {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: futureDate(168),
  });
  const session = await createSession(user.id);
  // supertest doesn't have a browser's cookie jar to sign for us — replicate
  // cookie-parser's own signing (it uses this exact package) so the request
  // carries a cookie the server will actually recognize as authentic.
  const signed = `s:${sign(session.id, process.env.SESSION_SECRET!)}`;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

describe('GET /api/me', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  });

  it('is 200 with user: null when signed out (never 401 — this is how the frontend probes login state)', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });

  it('is 200 with the real user when signed in', async () => {
    const cookie = await makeSignedInCookie('me');
    const res = await request(app).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ displayName: 'App Test (me)' });
  });

  it('ignores a garbage/forged cookie rather than erroring', async () => {
    const res = await request(app).get('/api/me').set('Cookie', `${SESSION_COOKIE_NAME}=not-a-real-signed-value`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: null });
  });
});

function sendRequest(method: 'GET' | 'POST', path: string) {
  return method === 'GET' ? request(app).get(path) : request(app).post(path);
}

describe('requireAuth gating on protected routers', () => {
  const protectedRequests: ['GET' | 'POST', string][] = [
    ['POST', '/api/event/resolve'],
    ['GET', '/api/sets/12345/open-sets'],
    ['GET', '/api/characters/1'],
    ['GET', '/api/stages/1'],
    ['POST', '/api/report'],
  ];

  it.each(protectedRequests)('%s %s is 401 without a session', async (method, path) => {
    const res = await sendRequest(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Not signed in' });
  });

  it.each(protectedRequests)('%s %s gets past auth (no longer 401) with a valid session', async (method, path) => {
    const cookie = await makeSignedInCookie(`gate-${method}-${path.replace(/\W+/g, '')}`);
    const res = await sendRequest(method, path).set('Cookie', cookie);
    // Downstream handlers will fail against a fake token/id (start.gg 502s,
    // or a 400 for a malformed body) — the thing this asserts is narrower
    // and specific to requireAuth: it must not be blocked at the gate.
    expect(res.status).not.toBe(401);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  });
});

describe('POST /api/auth/logout', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('actually revokes the session server-side, not just the cookie client-side', async () => {
    const cookie = await makeSignedInCookie('logout');

    const before = await request(app).get('/api/me').set('Cookie', cookie);
    expect(before.body.user).not.toBeNull();

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body).toEqual({ ok: true });

    // The same cookie must no longer work — proves the session row was
    // actually deleted server-side, not merely that the client forgot it.
    const after = await request(app).get('/api/me').set('Cookie', cookie);
    expect(after.body.user).toBeNull();
  });

  it('is a harmless no-op when already signed out', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
