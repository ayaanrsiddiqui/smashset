import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';

const gqlMock = vi.fn();
vi.mock('../startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
}));

const { createApp } = await import('../app.js');
const { subscribe, resetPoolEvents } = await import('../poolEvents.js');
const app = createApp();

const PREFIX = `test-report-route-${Date.now()}-`;

async function makeSignedInCookie(label: string): Promise<string> {
  const user = await upsertUserFromOAuth(`${PREFIX}${label}`, null, `Report Route Test (${label})`, {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 168 * 60 * 60 * 1000),
  });
  const session = await createSession(user.id);
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${sign(session.id, process.env.SESSION_SECRET!)}`)}`;
}

const VALID = { setId: 7001, winnerEntrantId: 8001, loserEntrantId: 8002, requiredWins: 2, shorthand: '+' };

/** Records what a TO watching a pool is told. */
function watcher(phaseGroupId: string) {
  const received: string[] = [];
  subscribe(phaseGroupId, { userId: 99, send: (e) => (received.push(e), true) });
  return received;
}

describe('POST /api/report', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('rejects an unauthenticated report', async () => {
    const res = await request(app).post('/api/report').send(VALID);
    expect(res.status).toBe(401);
  });

  it('tells everyone watching that pool, without anyone asking start.gg', async () => {
    // The point of the whole channel: a report made here is already known, so
    // the other TOs at the venue hear it for free rather than each spending a
    // poll to rediscover it.
    gqlMock.mockResolvedValue({ reportBracketSet: [{ id: 7001 }] });
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('publishes');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(res.status).toBe(200);
    expect(heard).toEqual(['changed']);
  });

  it('leaves other pools alone', async () => {
    gqlMock.mockResolvedValue({ reportBracketSet: [{ id: 7001 }] });
    const elsewhere = watcher('2');
    const cookie = await makeSignedInCookie('other-pool');

    await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(elsewhere).toEqual([]);
  });

  it('still reports when the client sends no pool, it just tells nobody', async () => {
    // An older client, or one that has not loaded a pool. The report must not
    // fail over a notification hint.
    gqlMock.mockResolvedValue({ reportBracketSet: [{ id: 7001 }] });
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('no-pool');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(200);
    expect(heard).toEqual([]);
  });

  it('tells nobody when the report itself failed', async () => {
    // Announcing a change that did not happen makes every watcher refetch for
    // nothing, and briefly disagree about the bracket.
    gqlMock.mockRejectedValue(new Error('start.gg is down'));
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('failed');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(res.status).toBe(502);
    expect(heard).toEqual([]);
  });
});
