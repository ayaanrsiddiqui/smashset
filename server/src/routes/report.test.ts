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

/** What start.gg holds for the set being reported, before this report lands. */
const OPEN_SET = { id: 7001, state: 2, winnerId: null, slots: [{ entrant: { id: 8001, name: 'Ada' } }, { entrant: { id: 8002, name: 'mudd' } }] };
const COMPLETED_SET = { ...OPEN_SET, state: 3, winnerId: 8001 };

/**
 * Routes each query to its own answer. The route reads the set before writing
 * it, so a single mockResolvedValue would feed the mutation's response to the
 * read as well.
 */
function startgg(over: { set?: unknown; report?: unknown; update?: unknown; reset?: unknown } = {}) {
  gqlMock.mockImplementation((_token: string, query: string) => {
    if (query.includes('ReportPrecondition')) {
      return over.set instanceof Error ? Promise.reject(over.set) : Promise.resolve({ set: 'set' in over ? over.set : OPEN_SET });
    }
    if (query.includes('resetSet')) {
      return over.reset instanceof Error ? Promise.reject(over.reset) : Promise.resolve(over.reset ?? { resetSet: { id: 7001, state: 1 } });
    }
    if (query.includes('updateBracketSet')) {
      return over.update instanceof Error ? Promise.reject(over.update) : Promise.resolve(over.update ?? { updateBracketSet: { id: 7001, state: 3 } });
    }
    return over.report instanceof Error ? Promise.reject(over.report) : Promise.resolve(over.report ?? { reportBracketSet: [{ id: 7001 }] });
  });
}

/** Which mutations actually reached start.gg, in order. */
function mutations(): string[] {
  return gqlMock.mock.calls
    .map(([, query]) => /mutation (\w+)/.exec(query as string)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Records what a TO watching a pool is told. */
function watcher(phaseGroupId: string) {
  const received: string[] = [];
  subscribe(phaseGroupId, { userId: 99, send: (e) => (received.push(e), true) });
  return received;
}

afterAll(async () => {
  await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  await closeTestPool();
});

describe('POST /api/report', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  it('rejects an unauthenticated report', async () => {
    const res = await request(app).post('/api/report').send(VALID);
    expect(res.status).toBe(401);
  });

  it('tells everyone watching that pool, without anyone asking start.gg', async () => {
    // The point of the whole channel: a report made here is already known, so
    // the other TOs at the venue hear it for free rather than each spending a
    // poll to rediscover it.
    startgg();
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('publishes');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(res.status).toBe(200);
    expect(heard).toEqual(['changed']);
  });

  it('leaves other pools alone', async () => {
    startgg();
    const elsewhere = watcher('2');
    const cookie = await makeSignedInCookie('other-pool');

    await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(elsewhere).toEqual([]);
  });

  it('still reports when the client sends no pool, it just tells nobody', async () => {
    // An older client, or one that has not loaded a pool. The report must not
    // fail over a notification hint.
    startgg();
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('no-pool');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(200);
    expect(heard).toEqual([]);
  });

  it('tells nobody when the report itself failed', async () => {
    // Announcing a change that did not happen makes every watcher refetch for
    // nothing, and briefly disagree about the bracket.
    startgg({ report: new Error('start.gg is down') });
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('failed');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(res.status).toBe(502);
    expect(heard).toEqual([]);
  });
});

/**
 * start.gg refuses reportBracketSet on a set it already considers finished
 * ("Cannot report completed set via API." — verified live on 2026-09-12), so
 * the correction flow the app has always offered could never have worked. A
 * completed set takes updateBracketSet instead, and changing who won needs the
 * result torn down first.
 */
describe('POST /api/report — correcting a set start.gg already considers finished', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  it('edits the score in place, instead of re-reporting a set start.gg would refuse', async () => {
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('correct-score');

    // Same winner, different score: 2-0 becomes 2-1.
    const res = await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, shorthand: 'WLW' });

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['UpdateSet']);
  });

  it('refuses to change who won until the TO has been told what it will unmake', async () => {
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('flip-unconfirmed');

    // mudd now reported as the winner — start.gg can only do this by tearing
    // down the result, and everything downstream of it, first.
    const res = await request(app)
      .post('/api/report')
      .set('Cookie', cookie)
      .send({ ...VALID, winnerEntrantId: 8002, loserEntrantId: 8001 });

    expect(res.status).toBe(409);
    expect(res.body.requiresReset).toBe(true);
    expect(mutations()).toEqual([]);
  });

  it('tears down the old result and reports the new one once the TO confirms', async () => {
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('flip-confirmed');

    const res = await request(app)
      .post('/api/report')
      .set('Cookie', cookie)
      .send({ ...VALID, winnerEntrantId: 8002, loserEntrantId: 8001, confirmReset: true });

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['ResetSet', 'ReportSet']);
  });

  it('says plainly when the old result was cleared but the new one did not save', async () => {
    // There is no transaction across two start.gg mutations. Landing here
    // leaves the set genuinely unreported, and the TO is the only one who can
    // put it right — so this must never read like an ordinary failed report.
    startgg({ set: COMPLETED_SET, report: new Error('start.gg did not respond in time.') });
    const cookie = await makeSignedInCookie('half-done');

    const res = await request(app)
      .post('/api/report')
      .set('Cookie', cookie)
      .send({ ...VALID, winnerEntrantId: 8002, loserEntrantId: 8001, confirmReset: true });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/cleared/i);
    expect(res.body.error).toMatch(/report it again/i);
  });

  it('still reports a set nobody has finished yet', async () => {
    startgg({ set: OPEN_SET });
    const cookie = await makeSignedInCookie('normal');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['ReportSet']);
  });
});

/**
 * A report naming someone who is not in the set is not merely rejected by
 * start.gg — verified live, it writes the game rows first and does not roll
 * them back, leaving phantom games owned by a non-entrant on a set that still
 * reads as unreported. Nothing this app can do clears that, so the request has
 * to die here rather than reach start.gg.
 */
describe('POST /api/report — a report that would corrupt the set', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  it('never sends a report whose winner is not in the set', async () => {
    startgg({ set: OPEN_SET });
    const cookie = await makeSignedInCookie('stranger');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send({ ...VALID, winnerEntrantId: 9999 });

    expect(res.status).toBe(409);
    expect(mutations()).toEqual([]);
  });

  it('never sends a report against a set whose entrants are not filled in', async () => {
    startgg({ set: { ...OPEN_SET, slots: [{ entrant: { id: 8001, name: 'Ada' } }, { entrant: null }] } });
    const cookie = await makeSignedInCookie('tbd');

    const res = await request(app).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(409);
    expect(mutations()).toEqual([]);
  });
});
