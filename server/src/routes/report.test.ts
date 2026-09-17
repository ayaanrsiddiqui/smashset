import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';
import { testServer } from '../test-server.js';
import { StartggError } from '../startgg.js';

const gqlMock = vi.fn();
vi.mock('../startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
  // The cascade lookup pages through fetchSetsPaged, which uses this one — left
  // real it would put every test in this file on the network.
  gqlWithCost: async (...args: unknown[]) => ({ data: await gqlMock(...args), complexity: null }),
}));

const { createApp } = await import('../app.js');
const { subscribe, resetPoolEvents } = await import('../poolEvents.js');
const server = testServer(createApp());

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
const OPEN_SET = { id: 7001, state: 2, winnerId: null, displayScore: null, phaseGroup: { id: 1 }, slots: [{ entrant: { id: 8001, name: 'Ada' } }, { entrant: { id: 8002, name: 'mudd' } }] };
const COMPLETED_SET = { ...OPEN_SET, state: 3, winnerId: 8001, displayScore: 'Ada 2 - mudd 0' };

/** 7001 feeds a played set directly, and another through a bye, as start.gg models it. */
const CASCADE_SETS = [
  { id: 7001, identifier: 'A', state: 3, slots: [{ prereqId: null, prereqType: null }] },
  { id: 7002, identifier: 'I', state: 3, slots: [{ prereqId: '7001', prereqType: 'set' }] },
  { id: 7003, identifier: 'AN', state: 3, slots: [{ prereqId: '7001', prereqType: 'set' }, { prereqId: '9', prereqType: 'bye' }] },
  { id: 7004, identifier: 'R', state: 3, slots: [{ prereqId: '7003', prereqType: 'set' }] },
];

/**
 * Routes each query to its own answer. The route reads the set before writing
 * it, so a single mockResolvedValue would feed the mutation's response to the
 * read as well.
 */
function startgg(over: { set?: unknown; report?: unknown; update?: unknown; reset?: unknown; cascade?: unknown; live?: unknown } = {}) {
  gqlMock.mockImplementation((_token: string, query: string) => {
    if (query.includes('ReportPrecondition')) {
      return over.set instanceof Error ? Promise.reject(over.set) : Promise.resolve({ set: 'set' in over ? over.set : OPEN_SET });
    }
    if (query.includes('PhaseGroupBracket')) {
      if (over.live instanceof Error) return Promise.reject(over.live);
      return Promise.resolve(over.live ?? { phaseGroup: { id: 1, sets: { pageInfo: { totalPages: 1 }, nodes: [] } } });
    }
    if (query.includes('PhaseGroupCascade')) {
      if (over.cascade instanceof Error) return Promise.reject(over.cascade);
      return Promise.resolve(
        over.cascade ?? { phaseGroup: { id: 1, sets: { pageInfo: { totalPages: 1 }, nodes: CASCADE_SETS } } }
      );
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
    const res = await request(server).post('/api/report').send(VALID);
    expect(res.status).toBe(401);
  });

  it('tells everyone watching that pool, without anyone asking start.gg', async () => {
    // The point of the whole channel: a report made here is already known, so
    // the other TOs at the venue hear it for free rather than each spending a
    // poll to rediscover it.
    startgg();
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('publishes');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(res.status).toBe(200);
    expect(heard).toEqual(['changed']);
  });

  it('leaves other pools alone', async () => {
    startgg();
    const elsewhere = watcher('2');
    const cookie = await makeSignedInCookie('other-pool');

    await request(server).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

    expect(elsewhere).toEqual([]);
  });

  it('still reports when the client sends no pool, it just tells nobody', async () => {
    // An older client, or one that has not loaded a pool. The report must not
    // fail over a notification hint.
    startgg();
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('no-pool');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(200);
    expect(heard).toEqual([]);
  });

  it('tells nobody when the report itself failed', async () => {
    // Announcing a change that did not happen makes every watcher refetch for
    // nothing, and briefly disagree about the bracket.
    startgg({ report: new Error('start.gg is down') });
    const heard = watcher('1');
    const cookie = await makeSignedInCookie('failed');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...VALID, phaseGroupId: '1' });

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
    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...VALID, shorthand: 'WLW' });

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['UpdateSet']);
  });

  it('refuses to change who won until the TO has been told what it will unmake', async () => {
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('flip-unconfirmed');

    // mudd now reported as the winner — start.gg can only do this by tearing
    // down the result, and everything downstream of it, first.
    const res = await request(server)
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

    const res = await request(server)
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

    const res = await request(server)
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

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

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

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...VALID, winnerEntrantId: 9999 });

    expect(res.status).toBe(409);
    expect(mutations()).toEqual([]);
  });

  it('never sends a report against a set whose entrants are not filled in', async () => {
    startgg({ set: { ...OPEN_SET, slots: [{ entrant: { id: 8001, name: 'Ada' } }, { entrant: null }] } });
    const cookie = await makeSignedInCookie('tbd');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(409);
    expect(mutations()).toEqual([]);
  });
});

describe('POST /api/report — telling the TO what a teardown costs', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  const flip = { ...VALID, winnerEntrantId: 8002, loserEntrantId: 8001 };

  it('names the already-played sets the teardown would wipe', async () => {
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('would-clear');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(flip);

    // R is only reachable through the bye set start.gg hides by default.
    expect(res.body.wouldClear).toEqual(['I', 'R']);
  });

  it('asks start.gg for bye sets, without which the losers bracket is invisible', async () => {
    // Verified live: walking only the sets start.gg returns by default named 2
    // of the 3 sets a real reset cleared. Understating a destructive action is
    // the worst way for this to be wrong, so the filter is pinned here.
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('shows-byes');

    await request(server).post('/api/report').set('Cookie', cookie).send(flip);

    const cascadeQuery = gqlMock.mock.calls.map(([, q]) => q as string).find((q) => q.includes('PhaseGroupCascade'));
    expect(cascadeQuery).toMatch(/showByes:\s*true/);
  });

  it('says it does not know when start.gg has no such pool, too', async () => {
    startgg({ set: COMPLETED_SET, cascade: { phaseGroup: null } });
    const cookie = await makeSignedInCookie('cascade-empty');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(flip);

    expect(res.body.wouldClear).toBeNull();
  });

  it('says it does not know rather than implying nothing else is affected', async () => {
    // A failed lookup must not render as an empty list — that reads as "this
    // clears nothing else", which is the opposite of what is known.
    startgg({ set: COMPLETED_SET, cascade: new Error('start.gg is down') });
    const cookie = await makeSignedInCookie('cascade-down');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(flip);

    expect(res.status).toBe(409);
    expect(res.body.wouldClear).toBeNull();
  });
});

/**
 * An outbox delivers at least once, so the same report can arrive twice: the
 * first attempt landed and its response died on venue wifi. A retry must not
 * be the thing that overwrites a result somebody has since corrected.
 *
 * Only retries are guarded. A first attempt is a TO looking at the set and
 * deciding, which is exactly when overwriting is the point.
 */
describe('POST /api/report — a retry arriving after the set already moved', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  // VALID is a clean 2-0 for 8001, which is what COMPLETED_SET already holds.
  const retry = { ...VALID, attempt: 2 };

  it('stops when the result on file is the one it was trying to report', async () => {
    // The ambiguous timeout: this attempt already landed. Reporting again
    // would be harmless but pointless, and failing would strand a red line on
    // a set that is correctly reported.
    startgg({ set: COMPLETED_SET });
    const cookie = await makeSignedInCookie('retry-converged');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(retry);

    expect(res.status).toBe(200);
    expect(res.body.alreadyOnFile).toBe(true);
    expect(mutations()).toEqual([]);
  });

  it('refuses to overwrite a different score somebody has since reported', async () => {
    startgg({ set: { ...COMPLETED_SET, displayScore: 'Ada 2 - mudd 1' } });
    const cookie = await makeSignedInCookie('retry-conflict');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(retry);

    expect(res.status).toBe(409);
    expect(res.body.retryable).toBe(false);
    expect(mutations()).toEqual([]);
  });

  it('refuses to overwrite a different winner, too', async () => {
    startgg({ set: { ...COMPLETED_SET, winnerId: 8002, displayScore: 'mudd 2 - Ada 0' } });
    const cookie = await makeSignedInCookie('retry-other-winner');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(retry);

    expect(res.status).toBe(409);
    expect(mutations()).toEqual([]);
  });

  it('refuses when it cannot read what is on file rather than assuming', async () => {
    // A DQ comes back as the bare string "DQ", so the score is unknowable. An
    // unreadable result is not a matching one.
    startgg({ set: { ...COMPLETED_SET, displayScore: 'DQ' } });
    const cookie = await makeSignedInCookie('retry-dq');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(retry);

    expect(res.status).toBe(409);
    expect(mutations()).toEqual([]);
  });

  it('still reports normally when the set is untouched', async () => {
    startgg({ set: OPEN_SET });
    const cookie = await makeSignedInCookie('retry-open');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(retry);

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['ReportSet']);
  });

  it('leaves a first attempt free to overwrite, which is what correcting means', async () => {
    startgg({ set: { ...COMPLETED_SET, displayScore: 'Ada 2 - mudd 1' } });
    const cookie = await makeSignedInCookie('first-attempt');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['UpdateSet']);
  });
});

/**
 * The outbox has to decide whether waiting will help. Everything used to come
 * back as a bare 502 with a message string, which is either hammering a
 * refusal that can never change or giving up on a four-second wifi blip.
 */
describe('POST /api/report — telling a retry apart from a dead end', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  it('marks a rate limit as worth retrying', async () => {
    const limited = new StartggError('start.gg is rate limiting us. Give it a moment and try again.', 429);
    startgg({ set: OPEN_SET, report: limited });
    const cookie = await makeSignedInCookie('rate-limited');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.body.retryable).toBe(true);
  });

  it('marks a dropped connection as worth retrying', async () => {
    // No status at all: the request never got an answer.
    startgg({ set: OPEN_SET, report: new StartggError('start.gg did not respond in time.') });
    const cookie = await makeSignedInCookie('timed-out');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.body.retryable).toBe(true);
  });

  it('marks start.gg refusing the report as a dead end', async () => {
    // start.gg answered, with a decision. Sending it again cannot change it.
    const refused = new StartggError('start.gg API error: Cannot report completed set via API.', 200, [
      { message: 'Cannot report completed set via API.' },
    ]);
    startgg({ set: OPEN_SET, report: refused });
    const cookie = await makeSignedInCookie('refused');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(VALID);

    expect(res.body.retryable).toBe(false);
  });
});

describe('POST /api/report against a bracket nobody has started', () => {
  const PREVIEW = { ...VALID, setId: 'preview_1_1_1' };
  /** A preview start.gg still holds: reportable, and reporting it starts the bracket. */
  const PREVIEW_SET = {
    id: 'preview_1_1_1',
    state: 1,
    winnerId: null,
    displayScore: null,
    phaseGroup: { id: 1 },
    slots: [{ entrant: { id: 8001, name: 'Ada' } }, { entrant: { id: 8002, name: 'mudd' } }],
  };
  /** The real set that preview became, holding exactly the reported result. */
  const MATERIALISED = {
    id: 7001,
    state: 3,
    winnerId: 8001,
    displayScore: 'Ada 2 - mudd 0',
    slots: [{ entrant: { id: 8001, name: 'Ada' } }, { entrant: { id: 8002, name: 'mudd' } }],
  };
  const livePage = (nodes: unknown[]) => ({ phaseGroup: { id: 1, sets: { pageInfo: { totalPages: 1 }, nodes } } });
  const lookedUpTheRealBracket = () => gqlMock.mock.calls.some(([, q]) => (q as string).includes('PhaseGroupBracket'));
  const sentTo = (name: string) =>
    (gqlMock.mock.calls.find(([, q]) => (q as string).includes(name))?.[2] as { setId: unknown }).setId;

  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  it('reports the preview set itself, which is what starts the bracket', async () => {
    // start.gg accepts a preview id, generates the bracket and applies the
    // result in one call (verified live 2026-09-17), so a TO never has to go
    // to start.gg to get the first set in.
    startgg({ set: PREVIEW_SET });
    const cookie = await makeSignedInCookie('preview-first');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(PREVIEW);

    expect(res.status).toBe(200);
    expect(mutations()).toEqual(['ReportSet']);
    expect(sentTo('reportBracketSet')).toBe('preview_1_1_1');
  });

  it('retires a retry whose preview was consumed by the report that landed', async () => {
    // The whole reason this reconciliation exists. The first attempt started
    // the bracket and its response died on venue wifi; the preview id is now
    // spent, so start.gg answers "Set not found" — a decision, not a blip, so
    // the outbox would dead-letter a report that was in fact correct and the
    // TO would report it a second time.
    startgg({ set: null, live: livePage([MATERIALISED]) });
    const cookie = await makeSignedInCookie('preview-retry');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...PREVIEW, attempt: 2 });

    expect(res.status).toBe(200);
    expect(res.body.alreadyOnFile).toBe(true);
    expect(mutations()).toEqual([]);
  });

  it('reports against the real set when someone else started the bracket first', async () => {
    // The set is real and still unreported, so this report belongs on it —
    // and must be addressed by the real id, not the spent preview one.
    startgg({ set: null, live: livePage([{ ...MATERIALISED, state: 2, winnerId: null, displayScore: null }]) });
    const cookie = await makeSignedInCookie('preview-started-elsewhere');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send(PREVIEW);

    expect(res.status).toBe(200);
    expect(sentTo('reportBracketSet')).toBe(7001);
  });

  it('refuses a retry when the real set now holds a different result', async () => {
    startgg({ set: null, live: livePage([{ ...MATERIALISED, winnerId: 8002, displayScore: 'Ada 0 - mudd 2' }]) });
    const cookie = await makeSignedInCookie('preview-retry-moved');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...PREVIEW, attempt: 2 });

    expect(res.status).toBe(409);
    expect(res.body.retryable).toBe(false);
    expect(mutations()).toEqual([]);
  });

  it('refuses rather than guessing when one pair of players has two sets', async () => {
    // Grand finals and its reset. Retiring a report against the wrong set is
    // the one outcome here that cannot be walked back.
    startgg({ set: null, live: livePage([MATERIALISED, { ...MATERIALISED, id: 7009 }]) });
    const cookie = await makeSignedInCookie('preview-ambiguous');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...PREVIEW, attempt: 2 });

    expect(res.status).toBe(404);
    expect(res.body.retryable).toBe(false);
    expect(lookedUpTheRealBracket(), 'refused without ever looking for the real set').toBe(true);
    expect(mutations()).toEqual([]);
  });

  it('refuses a preview from a phase that is still waiting on another one', async () => {
    // Top 8's previews exist but carry no entrants until the pools feeding it
    // finish (verified live 2026-09-17). Sending that to start.gg is the one
    // rejection that writes game rows before it validates, so it stops here.
    startgg({
      set: { ...PREVIEW_SET, id: 'preview_2_-3_0', slots: [{ entrant: null }, { entrant: null }] },
    });
    const cookie = await makeSignedInCookie('preview-unfed');

    const res = await request(server)
      .post('/api/report')
      .set('Cookie', cookie)
      .send({ ...PREVIEW, setId: 'preview_2_-3_0' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/both players/i);
    expect(mutations()).toEqual([]);
  });

  it('says the bracket moved on when nothing in the pool matches', async () => {
    startgg({ set: null, live: livePage([]) });
    const cookie = await makeSignedInCookie('preview-gone');

    const res = await request(server).post('/api/report').set('Cookie', cookie).send({ ...PREVIEW, attempt: 2 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/bracket has been started/i);
    expect(lookedUpTheRealBracket(), 'gave up without ever looking for the real set').toBe(true);
    expect(mutations()).toEqual([]);
  });
});
