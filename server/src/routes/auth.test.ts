import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession, getSessionWithUser } from '../db/sessions.js';
import { createAuthCode } from '../db/authCodes.js';
import { closeTestPool } from '../test-helpers.js';
import { testServer } from '../test-server.js';
import { createApp } from '../app.js';

const server = testServer(createApp());

const PREFIX = `test-auth-route-${Date.now()}-`;

async function makeSession(label: string): Promise<string> {
  const user = await upsertUserFromOAuth(`${PREFIX}${label}`, null, `Auth Route Test (${label})`, {
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

describe('GET /api/auth/login', () => {
  it('sends a web sign-in to start.gg with a web state', async () => {
    const res = await request(server).get('/api/auth/login');

    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get('state');
    expect(state?.endsWith('.web')).toBe(true);
  });

  it('marks an iOS sign-in in the state, so the callback knows where to send it', async () => {
    const res = await request(server).get('/api/auth/login?client=ios');

    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get('state');
    expect(state?.endsWith('.ios')).toBe(true);
  });

  it('treats an unrecognised client as the web app rather than guessing', async () => {
    const res = await request(server).get('/api/auth/login?client=android');

    const state = new URL(res.headers.location).searchParams.get('state');
    expect(state?.endsWith('.web')).toBe(true);
  });

  it('keeps the state it will compare against in a cookie, not only in the URL', async () => {
    const res = await request(server).get('/api/auth/login?client=ios');

    const state = new URL(res.headers.location).searchParams.get('state')!;
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('qs_oauth_state='));
    // Signed, so the cookie is not the bare value — but the state has to be in
    // there, or the callback's CSRF check has nothing to compare against.
    expect(decodeURIComponent(cookie!)).toContain(state);
  });
});

describe('POST /api/auth/exchange', () => {
  it('trades a code for the session it was issued for', async () => {
    const sessionId = await makeSession('exchange-ok');
    const code = await createAuthCode(sessionId);

    const res = await request(server).post('/api/auth/exchange').send({ code });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('hands back a session id that actually authenticates', async () => {
    const sessionId = await makeSession('exchange-usable');
    const code = await createAuthCode(sessionId);

    const exchanged = await request(server).post('/api/auth/exchange').send({ code });
    const me = await request(server).get('/api/me').set('Authorization', `Bearer ${exchanged.body.sessionId}`);

    // The point of the whole flow: what comes out the far end is a working
    // credential, not just a string that round-trips.
    expect(me.body.user).not.toBeNull();
    expect(me.body.user.displayName).toBe('Auth Route Test (exchange-usable)');
  });

  it('refuses a code the second time it is presented', async () => {
    const sessionId = await makeSession('exchange-replay');
    const code = await createAuthCode(sessionId);

    expect((await request(server).post('/api/auth/exchange').send({ code })).status).toBe(200);
    const second = await request(server).post('/api/auth/exchange').send({ code });

    expect(second.status).toBe(400);
    expect(second.body.sessionId).toBeUndefined();
  });

  it('refuses an expired code', async () => {
    const sessionId = await makeSession('exchange-expired');
    const code = await createAuthCode(sessionId);
    await pool.query(`UPDATE auth_codes SET expires_at = now() - interval '1 second' WHERE code = $1`, [code]);

    expect((await request(server).post('/api/auth/exchange').send({ code })).status).toBe(400);
  });

  it('gives an unknown code the same answer as a spent one', async () => {
    const spentSession = await makeSession('exchange-same-answer');
    const spent = await createAuthCode(spentSession);
    await request(server).post('/api/auth/exchange').send({ code: spent });

    const spentRes = await request(server).post('/api/auth/exchange').send({ code: spent });
    const unknownRes = await request(server).post('/api/auth/exchange').send({ code: 'never-issued' });

    // Telling them apart would confirm whether a given code was ever real.
    expect(unknownRes.status).toBe(spentRes.status);
    expect(unknownRes.body.error).toBe(spentRes.body.error);
  });

  it.each([
    ['an empty body', {}],
    ['a blank code', { code: '' }],
    ['a non-string code', { code: 12345 }],
  ])('rejects %s', async (_label, body) => {
    expect((await request(server).post('/api/auth/exchange').send(body)).status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session for a bearer client', async () => {
    const sessionId = await makeSession('logout-bearer');

    const res = await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${sessionId}`);

    expect(res.status).toBe(200);
    expect(await getSessionWithUser(sessionId)).toBeNull();
  });

  it('still ends the session for a cookie client', async () => {
    const sessionId = await makeSession('logout-cookie');
    const { sign } = await import('cookie-signature');
    const cookie = `qs_session=${encodeURIComponent(`s:${sign(sessionId, process.env.SESSION_SECRET!)}`)}`;

    const res = await request(server).post('/api/auth/logout').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(await getSessionWithUser(sessionId)).toBeNull();
  });
});
