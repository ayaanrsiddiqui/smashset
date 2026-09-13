import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession, getSessionWithUser } from '../db/sessions.js';
import { closeTestPool } from '../test-helpers.js';

const refreshAccessTokenMock = vi.fn();
// Spreads the real module so StartggOAuthError stays a real class — the
// refresh-failure handling does an instanceof against it to tell a rejected
// refresh token from start.gg simply being down.
vi.mock('../startggOAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../startggOAuth.js')>()),
  refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
}));

// Imported after the mock is registered so resolveSessionUser/requireAuth
// pick up the mocked refreshAccessToken instead of hitting start.gg for real.
const { resolveSessionUser, requireAuth, SESSION_COOKIE_NAME } = await import('./auth.js');
const { StartggOAuthError } = await import('../startggOAuth.js');

const PREFIX = `test-auth-mw-${Date.now()}-`;
const idFor = (label: string) => `${PREFIX}${label}`;

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function makeTestUser(label: string, expiresInHours: number) {
  return upsertUserFromOAuth(idFor(label), null, `Auth MW Tester (${label})`, {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: futureDate(expiresInHours),
  });
}

function fakeReq(sessionId: string | undefined): Request {
  return { signedCookies: sessionId ? { [SESSION_COOKIE_NAME]: sessionId } : {} } as unknown as Request;
}

function fakeRes(): Response & { clearCookie: ReturnType<typeof vi.fn>; cookie: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res: Record<string, unknown> = {};
  res.clearCookie = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as never;
}

describe('resolveSessionUser', () => {
  afterEach(() => {
    refreshAccessTokenMock.mockReset();
  });

  it('returns null when there is no session cookie at all', async () => {
    const res = fakeRes();
    expect(await resolveSessionUser(fakeReq(undefined), res)).toBeNull();
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it('returns null for a session id that does not exist', async () => {
    const res = fakeRes();
    expect(await resolveSessionUser(fakeReq('not-a-real-session'), res)).toBeNull();
  });

  it('returns the user with their current token when it is not close to expiry (no refresh)', async () => {
    const user = await makeTestUser('fresh', 168); // 7 days out, well outside the 1-day margin
    const session = await createSession(user.id);
    const res = fakeRes();

    const result = await resolveSessionUser(fakeReq(session.id), res);

    expect(result).toMatchObject({ id: user.id, accessToken: 'access-fresh' });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
  });

  it('proactively refreshes and persists a new token when within the 1-day margin', async () => {
    const user = await makeTestUser('near-expiry', 0.5); // 30 minutes out, inside the margin
    const session = await createSession(user.id);
    refreshAccessTokenMock.mockResolvedValue({
      accessToken: 'brand-new-access',
      refreshToken: 'brand-new-refresh',
      expiresAt: futureDate(168),
    });
    const res = fakeRes();

    const result = await resolveSessionUser(fakeReq(session.id), res);

    expect(refreshAccessTokenMock).toHaveBeenCalledWith('refresh-near-expiry');
    expect(result?.accessToken).toBe('brand-new-access');

    // Persisted, not just returned in-memory — a second lookup should see it too.
    const reloaded = await getSessionWithUser(session.id);
    expect(reloaded?.user.accessToken).toBe('brand-new-access');
  });

  it('de-dupes concurrent refreshes for the same user into a single upstream call', async () => {
    const user = await makeTestUser('concurrent', 0.5);
    const session = await createSession(user.id);
    let resolveRefresh!: (v: unknown) => void;
    refreshAccessTokenMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    const call1 = resolveSessionUser(fakeReq(session.id), fakeRes());
    const call2 = resolveSessionUser(fakeReq(session.id), fakeRes());
    // Let both calls reach the refresh check before resolving it.
    await new Promise((r) => setTimeout(r, 20));
    resolveRefresh({ accessToken: 'shared-new-access', refreshToken: 'shared-new-refresh', expiresAt: futureDate(168) });

    const [result1, result2] = await Promise.all([call1, call2]);

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(result1?.accessToken).toBe('shared-new-access');
    expect(result2?.accessToken).toBe('shared-new-access');
  });

  it('deletes the session and clears the cookie when the refresh token is dead', async () => {
    const user = await makeTestUser('dead-refresh', 0.5);
    const session = await createSession(user.id);
    // A status, not a message: the old plain Error meant any failure —
    // including a 500 — looked identical to a dead token, and the session was
    // destroyed either way.
    refreshAccessTokenMock.mockRejectedValue(new StartggOAuthError('start.gg token refresh failed (401)', 401));
    const res = fakeRes();

    const result = await resolveSessionUser(fakeReq(session.id), res);

    expect(result).toBeNull();
    expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(await getSessionWithUser(session.id)).toBeNull(); // actually revoked, not just forgotten client-side
  });

  it('extends the session cookie once it is past the halfway point of its TTL', async () => {
    const user = await makeTestUser('sliding', 168);
    const session = await createSession(user.id);
    // Force the session itself close to expiry (independent of the token's own expiry).
    await pool.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [session.id, futureDate(1)]);
    const res = fakeRes();

    await resolveSessionUser(fakeReq(session.id), res);

    expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, session.id, expect.objectContaining({ httpOnly: true }));
  });

  it('does not touch the session cookie when nowhere near its expiry', async () => {
    const user = await makeTestUser('not-sliding', 168);
    const session = await createSession(user.id); // fresh 30-day session
    const res = fakeRes();

    await resolveSessionUser(fakeReq(session.id), res);

    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe('resolveSessionUser — refresh failures', () => {
  afterEach(() => {
    refreshAccessTokenMock.mockReset();
  });

  it('keeps the session and serves the request on the current token when start.gg is merely unavailable', async () => {
    // Refreshes begin a day before the token expires, so a failure here says
    // nothing about whether the session is still good. Ending it would sign a
    // TO out mid-tournament over a start.gg hiccup.
    refreshAccessTokenMock.mockRejectedValue(new StartggOAuthError('start.gg token refresh failed (500): boom', 500));
    const user = await makeTestUser('refresh-transient', 12); // inside the margin, not expired
    const session = await createSession(user.id);
    const res = fakeRes();

    const resolved = await resolveSessionUser(fakeReq(session.id), res);

    expect(resolved).not.toBeNull();
    expect(resolved!.accessToken).toBe('access-refresh-transient');
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(await getSessionWithUser(session.id)).not.toBeNull();
  });

  it('ends the session when the current token has genuinely expired and cannot be renewed', async () => {
    refreshAccessTokenMock.mockRejectedValue(new StartggOAuthError('start.gg token refresh failed (503)', 503));
    const user = await makeTestUser('refresh-expired', -1); // already past expiry
    const session = await createSession(user.id);
    const res = fakeRes();

    expect(await resolveSessionUser(fakeReq(session.id), res)).toBeNull();
    expect(await getSessionWithUser(session.id)).toBeNull();
  });
});

describe('requireAuth', () => {
  afterEach(() => {
    refreshAccessTokenMock.mockReset();
  });

  it('calls next() and attaches req.user for a valid session', async () => {
    const user = await makeTestUser('require-auth-ok', 168);
    const session = await createSession(user.id);
    const req = fakeReq(session.id);
    const res = fakeRes();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: user.id, accessToken: 'access-require-auth-ok' });
  });

  it('responds 401 and does not call next() with no session', async () => {
    const req = fakeReq(undefined);
    const res = fakeRes();
    const next = vi.fn();

    await requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not signed in' });
  });
});

/** A native client's request: no cookie jar, the session id in a header. */
function bearerReq(header: string | undefined): Request {
  return { signedCookies: {}, headers: header === undefined ? {} : { authorization: header } } as unknown as Request;
}

describe('resolveSessionUser with a bearer token', () => {
  afterEach(() => {
    refreshAccessTokenMock.mockReset();
  });

  it('accepts the session id as a bearer token', async () => {
    const user = await makeTestUser('bearer-ok', 168);
    const session = await createSession(user.id);

    const result = await resolveSessionUser(bearerReq(`Bearer ${session.id}`), fakeRes());

    expect(result).toMatchObject({ id: user.id, accessToken: 'access-bearer-ok' });
  });

  it('matches the scheme case-insensitively, as HTTP requires', async () => {
    const user = await makeTestUser('bearer-case', 168);
    const session = await createSession(user.id);

    expect(await resolveSessionUser(bearerReq(`bearer ${session.id}`), fakeRes())).toMatchObject({ id: user.id });
  });

  it('returns null for a bearer token that is not a real session', async () => {
    expect(await resolveSessionUser(bearerReq('Bearer not-a-real-session'), fakeRes())).toBeNull();
  });

  it.each([
    ['no scheme', 'just-the-session-id'],
    ['the wrong scheme', 'Basic abc123'],
    ['an empty token', 'Bearer '],
  ])('returns null for a header with %s', async (_label, header) => {
    expect(await resolveSessionUser(bearerReq(header), fakeRes())).toBeNull();
  });

  it('still prefers the cookie when a request somehow carries both', async () => {
    const cookieUser = await makeTestUser('bearer-both-cookie', 168);
    const bearerUser = await makeTestUser('bearer-both-header', 168);
    const cookieSession = await createSession(cookieUser.id);
    const bearerSession = await createSession(bearerUser.id);
    const req = {
      signedCookies: { [SESSION_COOKIE_NAME]: cookieSession.id },
      headers: { authorization: `Bearer ${bearerSession.id}` },
    } as unknown as Request;

    expect(await resolveSessionUser(req, fakeRes())).toMatchObject({ id: cookieUser.id });
  });

  it('slides the session expiry in the database without setting a cookie', async () => {
    const user = await makeTestUser('bearer-slide', 168);
    const session = await createSession(user.id);
    // Push it past the halfway point so the renewal branch actually runs.
    const stale = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [session.id, stale]);
    const res = fakeRes();

    expect(await resolveSessionUser(bearerReq(`Bearer ${session.id}`), res)).not.toBeNull();

    // The row is what extends the session, so a native client gets the same
    // sliding window — it just has no cookie to restamp.
    const reloaded = await getSessionWithUser(session.id);
    expect(reloaded!.sessionExpiresAt.getTime()).toBeGreaterThan(stale.getTime());
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('destroys a session with a dead refresh token without clearing a cookie', async () => {
    const user = await makeTestUser('bearer-dead', -1); // already expired, so no usable current token
    const session = await createSession(user.id);
    refreshAccessTokenMock.mockRejectedValue(new StartggOAuthError('refresh rejected', 401));
    const res = fakeRes();

    expect(await resolveSessionUser(bearerReq(`Bearer ${session.id}`), res)).toBeNull();

    expect(await getSessionWithUser(session.id)).toBeNull();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  await closeTestPool();
});
