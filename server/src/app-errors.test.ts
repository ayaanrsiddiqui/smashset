import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { testServer } from './test-server.js';

const getSessionWithUserMock = vi.fn();
const deleteSessionMock = vi.fn();
vi.mock('./db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/sessions.js')>()),
  getSessionWithUser: (...args: unknown[]) => getSessionWithUserMock(...args),
  deleteSession: (...args: unknown[]) => deleteSessionMock(...args),
}));

const { createApp } = await import('./app.js');
const { SESSION_COOKIE_NAME } = await import('./middleware/auth.js');
const server = testServer(createApp());

function signedCookie(sessionId = 'some-session-id'): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${sign(sessionId, process.env.SESSION_SECRET!)}`)}`;
}

describe('an error no route handled', () => {
  beforeEach(() => {
    getSessionWithUserMock.mockReset();
    deleteSessionMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('answers in JSON instead of an HTML stack trace', async () => {
    // requireAuth has no try/catch of its own, so a database failure here
    // reaches Express unhandled — which without an error handler is an HTML
    // page the client's JSON parser chokes on.
    getSessionWithUserMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const res = await request(server).get('/api/sets/1/phase-groups').set('Cookie', signedCookie());

    expect(res.status).toBe(500);
    expect(res.type).toMatch(/json/);
    expect(res.body.error).toBeTruthy();
  });

  it('does not leak the underlying error to the client', async () => {
    getSessionWithUserMock.mockRejectedValue(new Error('connection to 10.0.0.4:5432 refused'));

    const res = await request(server).get('/api/sets/1/phase-groups').set('Cookie', signedCookie());

    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.4/);
    expect(JSON.stringify(res.body)).not.toMatch(/refused/);
  });
});

describe('POST /api/auth/logout when the session row cannot be deleted', () => {
  beforeEach(() => {
    getSessionWithUserMock.mockReset();
    deleteSessionMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('clears the cookie anyway, and says the session outlived the request', async () => {
    // Clearing the cookie last meant a failure here left both the cookie and
    // the row intact while the UI showed signed out — so the next page load
    // was quietly signed back in.
    deleteSessionMock.mockRejectedValue(new Error('db gone'));

    const res = await request(server).post('/api/auth/logout').set('Cookie', signedCookie());

    // supertest types this as a string; Node actually hands back an array.
    const setCookie = res.headers['set-cookie'] as unknown as string[] | string | undefined;
    expect(Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '')).toMatch(
      new RegExp(`${SESSION_COOKIE_NAME}=`)
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/could not be ended/i);
  });

  it('reports success and clears the cookie on the normal path', async () => {
    deleteSessionMock.mockResolvedValue(undefined);

    const res = await request(server).post('/api/auth/logout').set('Cookie', signedCookie());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteSessionMock).toHaveBeenCalledOnce();
  });
});
