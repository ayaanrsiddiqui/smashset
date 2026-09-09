import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession, getSessionWithUser } from '../db/sessions.js';
import { closeTestPool } from '../test-helpers.js';

const refreshAccessTokenMock = vi.fn();
vi.mock('../startggOAuth.js', () => ({
  refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
}));

// Imported after the mock is registered so resolveSessionUser/requireAuth
// pick up the mocked refreshAccessToken instead of hitting start.gg for real.
const { resolveSessionUser, requireAuth, SESSION_COOKIE_NAME } = await import('./auth.js');

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
    refreshAccessTokenMock.mockRejectedValue(new Error('start.gg token refresh failed (401)'));
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

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  await closeTestPool();
});
