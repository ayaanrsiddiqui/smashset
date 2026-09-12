import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';

const gqlMock = vi.fn();
// What start.gg reports a response cost. Null by default (most tests don't
// care), but the pager learns from it, so the cost-learning test drives it.
const complexityMock = vi.fn<() => number | null>(() => null);
// Only the two request functions are stubbed; the real error classes are kept
// so the bracket pager's instanceof check against StartggComplexityError still
// means something in tests.
vi.mock('../startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
  gqlWithCost: async (...args: unknown[]) => ({ data: await gqlMock(...args), complexity: complexityMock() }),
}));

// Imported after the mock is registered so app.js's import graph — sets.js ->
// startgg.js, and sets.js -> mainLookup.js -> startgg.js — picks up the
// mocked gql instead of hitting start.gg for real. Same ordering
// middleware/auth.test.ts already uses, for the same reason.
const { createApp } = await import('../app.js');
const { StartggComplexityError } = await import('../startgg.js');
const app = createApp();

const PREFIX = `test-sets-route-${Date.now()}-`;
const idFor = (label: string) => `${PREFIX}${label}`;
let nextTestEventId = 900001;

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function makeSignedInCookie(label: string): Promise<string> {
  const user = await upsertUserFromOAuth(idFor(label), null, `Sets Route Test (${label})`, {
    accessToken: `access-${label}`,
    refreshToken: `refresh-${label}`,
    expiresAt: futureDate(168),
  });
  const session = await createSession(user.id);
  // supertest doesn't have a browser's cookie jar to sign for us — replicate
  // cookie-parser's own signing (it uses this exact package), same recipe
  // app.test.ts uses.
  const signed = `s:${sign(session.id, process.env.SESSION_SECRET!)}`;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

const VIDEOGAME_ID = 1386;
const CACHED_PLAYER_ID = -101;
const UNCACHED_PLAYER_ID = -102;
const CACHED_CHARACTER_ID = 1338;

function openSetsFixture() {
  return {
    phaseGroup: {
      phase: { event: { videogame: { id: VIDEOGAME_ID } } },
      sets: {
        pageInfo: { totalPages: 1 },
        nodes: [
          {
            id: 5001,
            state: 2, // STARTED_STATE
            round: 1,
            fullRoundText: 'Winners Round 1',
            identifier: 'A',
            lPlacement: 17,
            slots: [
              { id: 's1', entrant: { id: 6001, name: 'Cached Player', participants: [{ player: { id: CACHED_PLAYER_ID } }] } },
              { id: 's2', entrant: { id: 6002, name: 'Uncached Player', participants: [{ player: { id: UNCACHED_PLAYER_ID } }] } },
            ],
          },
        ],
      },
    },
  };
}

const emptyPlayerHistory = () => ({ player: { sets: { nodes: [] } } });

interface ResponseEntrant {
  id: number;
  name: string;
  playerId?: number;
  suggestedMain?: { characterId: number | null; gamesTallied: number; setsConsidered: number };
}

describe('GET /phase-group/:phaseGroupId/open-sets — auto-main integration', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  afterAll(async () => {
    // Users cleanup + closeTestPool() happen once, in the last describe
    // block in this file (below) — the pool is a shared module-level
    // singleton, so closing it here would break that later block.
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [[CACHED_PLAYER_ID, UNCACHED_PLAYER_ID]]);
  });

  it('attaches suggestedMain (with confidence) for a cached player, omits it for an uncached one, and includes playerId', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [[CACHED_PLAYER_ID, UNCACHED_PLAYER_ID]]);
    await pool.query(
      `INSERT INTO player_mains (player_id, videogame_id, character_id, games_tallied, sets_considered)
       VALUES ($1, $2, $3, $4, $5)`,
      [CACHED_PLAYER_ID, VIDEOGAME_ID, CACHED_CHARACTER_ID, 6, 10]
    );
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupOpenSets')) return Promise.resolve(openSetsFixture());
      if (query.includes('PlayerMainHistory')) return Promise.resolve(emptyPlayerHistory());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('attach');
    const phaseGroupId = nextTestEventId++; // each test gets its own id so fetchOpenSets' 4s cache never crosses tests

    const res = await request(app).get(`/api/sets/phase-group/${phaseGroupId}/open-sets`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    const entrants: ResponseEntrant[] = res.body.sets[0].entrants;
    expect(entrants).toHaveLength(2);
    const cached = entrants.find((e) => e.name === 'Cached Player')!;
    const uncached = entrants.find((e) => e.name === 'Uncached Player')!;
    expect(cached.suggestedMain).toEqual({ characterId: CACHED_CHARACTER_ID, gamesTallied: 6, setsConsidered: 10 });
    expect(uncached.suggestedMain).toBeUndefined(); // still computing, not "checked and found nothing"
    expect(cached.playerId).toBe(CACHED_PLAYER_ID);
    expect(uncached.playerId).toBe(UNCACHED_PLAYER_ID);

    // One call for the open-sets query itself, one for the uncached player's
    // background history lookup — not two of the latter, since the cached
    // entrant must not re-trigger.
    await vi.waitFor(() => expect(gqlMock).toHaveBeenCalledTimes(2));
  });

  it('reporting a set drops the cached list, so the set it just closed cannot come back as open', async () => {
    let openSetsCalls = 0;
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupOpenSets')) {
        openSetsCalls++;
        return Promise.resolve(openSetsFixture());
      }
      if (query.includes('PlayerMainHistory')) return Promise.resolve(emptyPlayerHistory());
      if (query.includes('ReportSet')) return Promise.resolve({ reportBracketSet: { id: 5001 } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('report-invalidates');
    const phaseGroupId = nextTestEventId++;
    const url = `/api/sets/phase-group/${phaseGroupId}/open-sets`;

    await request(app).get(url).set('Cookie', cookie);
    expect(openSetsCalls).toBe(1);

    // Well inside the cache TTL, so this one is served locally.
    await request(app).get(url).set('Cookie', cookie);
    expect(openSetsCalls).toBe(1);

    const reported = await request(app).post('/api/report').set('Cookie', cookie).send({
      setId: 5001,
      winnerEntrantId: 6001,
      loserEntrantId: 6002,
      requiredWins: 2,
      shorthand: '0', // a clean 2-0
    });
    expect(reported.status).toBe(200);

    // Without invalidation the TO would keep seeing the set they just
    // reported sitting in the list, still waiting to be reported.
    await request(app).get(url).set('Cookie', cookie);
    expect(openSetsCalls).toBe(2);
  });

  it('a background lookup for a real uncached player actually lands in the database as a tombstone when it has no history', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [[CACHED_PLAYER_ID, UNCACHED_PLAYER_ID]]);
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupOpenSets')) return Promise.resolve(openSetsFixture());
      if (query.includes('PlayerMainHistory')) return Promise.resolve(emptyPlayerHistory());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('lands-in-db');
    const phaseGroupId = nextTestEventId++;

    await request(app).get(`/api/sets/phase-group/${phaseGroupId}/open-sets`).set('Cookie', cookie);

    await vi.waitFor(async () => {
      const { rows } = await pool.query('SELECT character_id FROM player_mains WHERE player_id = $1 AND videogame_id = $2', [
        UNCACHED_PLAYER_ID,
        VIDEOGAME_ID,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].character_id).toBeNull(); // no history in the fixture -> a real tombstone, not "not looked up"
    });
  });

  it('a pre-existing tombstone (confirmed no main) is distinguishable on the wire from "still computing"', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [[CACHED_PLAYER_ID, UNCACHED_PLAYER_ID]]);
    await pool.query(
      `INSERT INTO player_mains (player_id, videogame_id, character_id, games_tallied, sets_considered)
       VALUES ($1, $2, NULL, 0, 5)`,
      [CACHED_PLAYER_ID, VIDEOGAME_ID]
    );
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupOpenSets')) return Promise.resolve(openSetsFixture());
      if (query.includes('PlayerMainHistory')) return Promise.resolve(emptyPlayerHistory());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('tombstone-wire-shape');
    const phaseGroupId = nextTestEventId++;

    const res = await request(app).get(`/api/sets/phase-group/${phaseGroupId}/open-sets`).set('Cookie', cookie);

    const entrants: ResponseEntrant[] = res.body.sets[0].entrants;
    const cached = entrants.find((e) => e.name === 'Cached Player')!;
    // Present (not undefined) with characterId: null — "checked, no dominant
    // character" — as opposed to the uncached entrant a few tests up, whose
    // suggestedMain is undefined entirely because nothing has run yet.
    expect(cached.suggestedMain).toEqual({ characterId: null, gamesTallied: 0, setsConsidered: 5 });
  });

  it('does not block the HTTP response on the background lookup', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [[CACHED_PLAYER_ID, UNCACHED_PLAYER_ID]]);
    const releasers: ((v: unknown) => void)[] = [];
    const pendingPlayerHistory = () =>
      new Promise((resolve) => {
        releasers.push(resolve);
      });
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupOpenSets')) return Promise.resolve(openSetsFixture());
      // Both entrants are uncached at this point (player_mains was just
      // cleared above), so both trigger a background lookup — every one of
      // them stays pending until released below.
      if (query.includes('PlayerMainHistory')) return pendingPlayerHistory();
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('non-blocking');
    const phaseGroupId = nextTestEventId++;

    // If ensureMainComputed were accidentally awaited in the route handler,
    // this request would hang forever (the PlayerMainHistory mocks never
    // resolve until released below) and the test would time out — a direct,
    // automated proof of "must not block," not just an argument for it.
    const res = await request(app).get(`/api/sets/phase-group/${phaseGroupId}/open-sets`).set('Cookie', cookie);
    expect(res.status).toBe(200);

    // Release the pending mocks so both background tasks finish and their
    // in-flight tracking entries don't leak into later tests.
    for (const release of releasers) release(emptyPlayerHistory());
    await vi.waitFor(() => expect(gqlMock).toHaveBeenCalledTimes(1 + releasers.length));
  });
});

// The bracket endpoint now makes two queries with different shapes: a cheap
// "live" one it polls, and an expensive "structure" one for cross-phase wiring
// on a slower clock. Scores arrive as start.gg's rendered displayScore string
// rather than a standing object, since a scalar costs a fraction as much.
function bracketFixture() {
  return {
    phaseGroup: {
      id: 1,
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      phase: { name: 'Bracket' },
      sets: {
        pageInfo: { total: 3, totalPages: 1 },
        nodes: [
          {
            // Completed: both slots resolved, a real score, a winner.
            id: 7001,
            identifier: 'A',
            round: 1,
            fullRoundText: 'Winners Round 1',
            state: 3,
            winnerId: 8001,
            lPlacement: 9,
            displayScore: 'Winner Player 2 - Loser Player 0',
            completedAt: 1789000000,
            slots: [
              { entrant: { id: 8001, name: 'Winner Player' }, prereqType: 'seed', prereqId: '111', prereqPlacement: null },
              { entrant: { id: 8002, name: 'Loser Player' }, prereqType: 'seed', prereqId: '112', prereqPlacement: null },
            ],
          },
          {
            // Not ready: one slot still TBD, fed by set 7001's winner.
            id: 7002,
            identifier: 'C',
            round: 2,
            fullRoundText: 'Winners Quarter-Final',
            state: 1,
            winnerId: null,
            lPlacement: null,
            displayScore: null,
            completedAt: null,
            slots: [
              { entrant: { id: 8001, name: 'Winner Player' }, prereqType: 'set', prereqId: '7001', prereqPlacement: 1 },
              { entrant: null, prereqType: 'set', prereqId: '7099', prereqPlacement: 1 },
            ],
          },
          {
            // Malformed — not a 1v1 set (only one slot) — must be dropped,
            // not crash.
            id: 7004,
            identifier: 'Z',
            round: 1,
            fullRoundText: 'Round 1',
            state: 1,
            winnerId: null,
            lPlacement: null,
            displayScore: null,
            completedAt: null,
            slots: [{ entrant: { id: 8005, name: 'Orphan' }, prereqType: 'seed', prereqId: '115', prereqPlacement: null }],
          },
        ],
      },
    },
  };
}

function structureFixture() {
  return {
    phaseGroup: {
      id: 1,
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      phase: { name: 'Bracket' },
      sets: {
        pageInfo: { total: 3, totalPages: 1 },
        nodes: [
          {
            id: 7001,
            // This set's winner qualifies straight into a later "Top 8" phase
            // (a pool's terminal match); its loser goes no further.
            winnerProgressionSeed: { phase: { name: 'Top 8' } },
            loserProgressionSeed: null,
            slots: [
              // Winner Player's seed here came from a pool in an earlier phase.
              { seed: { progressionSource: { originPhase: { name: 'Pools' }, originPhaseGroup: { displayIdentifier: 'Pool B' } } } },
              // Loser Player entered directly — no earlier phase to arrive from.
              { seed: { progressionSource: null } },
            ],
          },
          { id: 7002, winnerProgressionSeed: null, loserProgressionSeed: null, slots: [{ seed: null }, { seed: null }] },
          { id: 7004, winnerProgressionSeed: null, loserProgressionSeed: null, slots: [{ seed: null }] },
        ],
      },
    },
  };
}

function poolFixture() {
  return {
    phaseGroup: {
      id: 2,
      displayIdentifier: 'Pool A',
      bracketType: 'ROUND_ROBIN',
      phase: { name: 'Pools' },
      sets: {
        pageInfo: { total: 1, totalPages: 1 },
        nodes: [
          {
            id: 7003,
            identifier: 'A',
            round: 1,
            fullRoundText: 'Round 1',
            state: 1,
            winnerId: null,
            lPlacement: null,
            displayScore: null,
            completedAt: null,
            slots: [
              { entrant: { id: 8003, name: 'Pool Player 1' }, prereqType: 'seed', prereqId: '113', prereqPlacement: null },
              { entrant: { id: 8004, name: 'Pool Player 2' }, prereqType: 'seed', prereqId: '114', prereqPlacement: null },
            ],
          },
        ],
      },
    },
  };
}

function emptyStructure(id: number, displayIdentifier: string, bracketType: string, phaseName: string) {
  return {
    phaseGroup: {
      id,
      displayIdentifier,
      bracketType,
      phase: { name: phaseName },
      sets: { pageInfo: { total: 0, totalPages: 1 }, nodes: [] },
    },
  };
}

interface ResponseSlot {
  entrant: { id: number; name: string } | null;
  score: number | null;
  prereqSetId: string | null;
  prereqPlacement: 1 | 2 | null;
  progressionOrigin: { phaseName: string; poolName: string | null } | null;
}
interface ResponseBracketSet {
  id: number | string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: number | null;
  slots: ResponseSlot[];
  winnerAdvancesToPhase: string | null;
  loserAdvancesToPhase: string | null;
}
interface ResponseBracketGroup {
  phaseGroupId: number;
  phaseName: string;
  displayIdentifier: string;
  bracketType: string;
  sets: ResponseBracketSet[];
}

describe('GET /phase-group/:phaseGroupId/bracket', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  it("returns one phase group's full bracket — completed scores, TBD slots via prereqSetId/prereqPlacement, and cross-phase progression links", async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve(bracketFixture());
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('bracket-basic');

    const res = await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);

    expect(res.status).toBe(200);
    const group: ResponseBracketGroup = res.body;
    expect(group).toMatchObject({ phaseGroupId: 1, phaseName: 'Bracket', displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION' });

    // The malformed (only 1 slot) node never surfaces.
    expect(group.sets.find((s) => s.id === 7004)).toBeUndefined();
    expect(group.sets).toHaveLength(2);

    const completed = group.sets.find((s) => s.id === 7001)!;
    expect(completed.state).toBe(3);
    expect(completed.winnerId).toBe(8001);
    expect(completed.slots[0]).toMatchObject({ entrant: { id: 8001, name: 'Winner Player' }, score: 2, prereqSetId: null });
    expect(completed.slots[1]).toMatchObject({ entrant: { id: 8002, name: 'Loser Player' }, score: 0, prereqSetId: null });
    // This set's winner is itself a seed feeding a later "Top 8" phase.
    expect(completed.winnerAdvancesToPhase).toBe('Top 8');
    expect(completed.loserAdvancesToPhase).toBeNull();
    // Winner Player's own seed here came from an earlier pools phase…
    expect(completed.slots[0].progressionOrigin).toEqual({ phaseName: 'Pools', poolName: 'Pool B' });
    // …while Loser Player entered directly (no progressionSource at all).
    expect(completed.slots[1].progressionOrigin).toBeNull();

    const notReady = group.sets.find((s) => s.id === 7002)!;
    expect(notReady.slots[0]).toMatchObject({ entrant: { id: 8001, name: 'Winner Player' }, prereqSetId: '7001', prereqPlacement: 1 });
    expect(notReady.slots[1]).toMatchObject({ entrant: null, prereqSetId: '7099', prereqPlacement: 1 });
  });

  it('scopes strictly to the requested phaseGroupId — a different pool never leaks into the response', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string, variables: Record<string, unknown>) => {
      if (query.includes('PhaseGroupBracket') && variables.phaseGroupId === '2') return Promise.resolve(poolFixture());
      if (query.includes('PhaseGroupProgression') && variables.phaseGroupId === '2') {
        return Promise.resolve(emptyStructure(2, 'Pool A', 'ROUND_ROBIN', 'Pools'));
      }
      throw new Error(`unexpected query/variables in test: ${query} ${JSON.stringify(variables)}`);
    });
    const cookie = await makeSignedInCookie('bracket-scoped');

    const res = await request(app).get('/api/sets/phase-group/2/bracket').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phaseGroupId: 2, phaseName: 'Pools', displayIdentifier: 'Pool A', bracketType: 'ROUND_ROBIN' });
    expect(res.body.sets.map((s: ResponseBracketSet) => s.id)).toEqual([7003]);
  });

  it('recovers from a query-complexity rejection by retrying with a strictly smaller page', async () => {
    const perPages: number[] = [];
    gqlMock.mockImplementation((_token: unknown, query: string, variables: Record<string, unknown>) => {
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (!query.includes('PhaseGroupBracket')) throw new Error(`unexpected query in test: ${query}`);
      // Only the live query's page sizes are under test here.
      const perPage = variables.perPage as number;
      perPages.push(perPage);
      // Stands in for a pool whose sets are pricier than the measured
      // ceiling, so the first page start.gg would accept is much smaller than
      // the one the cost model picked.
      if (perPage > 10) {
        throw new StartggComplexityError(
          'Your query complexity is too high. A maximum of 1000 objects may be returned by each request. (actual: 1350)',
          1350
        );
      }
      return Promise.resolve(bracketFixture());
    });
    const cookie = await makeSignedInCookie('bracket-complexity');

    const res = await request(app).get('/api/sets/phase-group/42/bracket').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.sets).toHaveLength(2);
    expect(perPages.length).toBeGreaterThan(1);
    // Every retry asks for strictly fewer sets than the last, which is what
    // makes this terminate rather than loop on the same rejected page size.
    for (let i = 1; i < perPages.length; i++) expect(perPages[i]).toBeLessThan(perPages[i - 1]);
    expect(perPages[perPages.length - 1]).toBeLessThanOrEqual(10);
  });

  it('gives up rather than looping when no page size is small enough', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (!query.includes('PhaseGroupBracket')) throw new Error(`unexpected query in test: ${query}`);
      throw new StartggComplexityError('Your query complexity is too high. (actual: 5000)', 5000);
    });
    const cookie = await makeSignedInCookie('bracket-complexity-hopeless');

    const res = await request(app).get('/api/sets/phase-group/43/bracket').set('Cookie', cookie);

    expect(res.status).toBe(502);
  });

  it('caches per user — a repeat fetch is served locally, but another user still goes to start.gg', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve(bracketFixture());
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const alice = await makeSignedInCookie('bracket-cache-alice');
    const bob = await makeSignedInCookie('bracket-cache-bob');

    await request(app).get('/api/sets/phase-group/77/bracket').set('Cookie', alice);
    const afterAlice = gqlMock.mock.calls.length;
    expect(afterAlice).toBeGreaterThan(0);

    // Alice again, same pool, well inside the TTL — no second trip upstream.
    await request(app).get('/api/sets/phase-group/77/bracket').set('Cookie', alice);
    expect(gqlMock.mock.calls.length).toBe(afterAlice);

    // Bob must not be answered from Alice's entry: start.gg decides per token
    // which tournaments are visible, so his request goes out under his own.
    await request(app).get('/api/sets/phase-group/77/bracket').set('Cookie', bob);
    expect(gqlMock.mock.calls.length).toBeGreaterThan(afterAlice);
  });

  it('learns a higher per-set cost from what start.gg reports, and shrinks the next page', async () => {
    const perPages: number[] = [];
    gqlMock.mockImplementation((_token: unknown, query: string, variables: Record<string, unknown>) => {
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (!query.includes('PhaseGroupBracket')) throw new Error(`unexpected query in test: ${query}`);
      perPages.push(variables.perPage as number);
      return Promise.resolve(bracketFixture());
    });
    // The fixture returns 3 sets; 123 objects for those means ~40 each, far
    // above the 7 the cost model assumes.
    complexityMock.mockReturnValue(123);

    const alice = await makeSignedInCookie('cost-learn-a');
    await request(app).get('/api/sets/phase-group/88/bracket').set('Cookie', alice);
    const firstPage = perPages[0];

    // A different user misses the per-user cache, so this really re-fetches.
    const bob = await makeSignedInCookie('cost-learn-b');
    await request(app).get('/api/sets/phase-group/88/bracket').set('Cookie', bob);

    expect(perPages.at(-1)!).toBeLessThan(firstPage);
  });

  it('re-fetches the live half far more often than the progression wiring', async () => {
    const counts = { live: 0, structure: 0 };
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupProgression')) {
        counts.structure++;
        return Promise.resolve(structureFixture());
      }
      if (query.includes('PhaseGroupBracket')) {
        counts.live++;
        return Promise.resolve(bracketFixture());
      }
      throw new Error(`unexpected query in test: ${query}`);
    });

    // Two users, so the per-user live cache misses both times. The structure
    // cache is shared and much longer-lived — that split is the entire reason
    // the bracket query was cut in two.
    const alice = await makeSignedInCookie('struct-ttl-a');
    const bob = await makeSignedInCookie('struct-ttl-b');
    await request(app).get('/api/sets/phase-group/89/bracket').set('Cookie', alice);
    await request(app).get('/api/sets/phase-group/89/bracket').set('Cookie', bob);

    expect(counts.live).toBe(2);
    expect(counts.structure).toBe(1);
  });

  it('404s when the phase group does not exist', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve({ phaseGroup: null });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('bracket-missing');

    const res = await request(app).get('/api/sets/phase-group/999999/bracket').set('Cookie', cookie);

    expect(res.status).toBe(404);
  });
});

interface ResponsePhaseGroupSummary {
  id: number;
  displayIdentifier: string;
  phaseId: number;
  phaseName: string;
  phaseNumSeeds: number;
  bracketType: string;
}

describe('GET /phase/:phaseId/pool-preview', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  function standings(names: string[], total: number) {
    return { pageInfo: { total }, nodes: names.map((name) => ({ entrant: { name } })) };
  }

  it('returns the few names each pool shows, with how many are not shown', async () => {
    gqlMock.mockImplementation((_t: unknown, query: string) => {
      if (!query.includes('PhasePoolPreviews')) throw new Error(`unexpected query: ${query}`);
      return Promise.resolve({
        phase: {
          phaseGroups: {
            pageInfo: { totalPages: 1 },
            nodes: [
              { id: 1, standings: standings(['FaZe | Sparg0', 'Dolan'], 25) },
              { id: 2, standings: standings(['BTS | Atomic'], 1) },
            ],
          },
        },
      });
    });
    const cookie = await makeSignedInCookie('pool-preview');

    const res = await request(app).get('/api/sets/phase/777/pool-preview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.previews).toEqual([
      { phaseGroupId: 1, names: ['FaZe | Sparg0', 'Dolan'], total: 25 },
      { phaseGroupId: 2, names: ['BTS | Atomic'], total: 1 },
    ]);
  });

  it('pages through a phase with more pools than fit in one request', async () => {
    gqlMock.mockImplementation((_t: unknown, _q: string, vars: { page: number }) =>
      Promise.resolve({
        phase: {
          phaseGroups: {
            pageInfo: { totalPages: 2 },
            nodes: [{ id: vars.page, standings: standings([`Pool ${vars.page}`], 1) }],
          },
        },
      })
    );
    const cookie = await makeSignedInCookie('pool-preview-paged');

    const res = await request(app).get('/api/sets/phase/778/pool-preview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.previews.map((p: { phaseGroupId: number }) => p.phaseGroupId)).toEqual([1, 2]);
  });

  it('shrinks the page and starts over when start.gg calls the request too complex', async () => {
    // The self-healing shape the set pager already uses: read start.gg's own
    // reported cost back, rather than trusting a constant tuned once.
    let firstPerPage = 0;
    let retryPerPage = 0;
    gqlMock.mockImplementation((_t: unknown, _q: string, vars: { page: number; perPage: number }) => {
      if (firstPerPage === 0) {
        firstPerPage = vars.perPage;
        throw new StartggComplexityError('Your query complexity is too high. (actual: 4000)', 4000);
      }
      retryPerPage = vars.perPage;
      return Promise.resolve({
        phase: { phaseGroups: { pageInfo: { totalPages: 1 }, nodes: [{ id: 9, standings: standings(['Recovered'], 1) }] } },
      });
    });
    const cookie = await makeSignedInCookie('pool-preview-complex');

    const res = await request(app).get('/api/sets/phase/779/pool-preview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(retryPerPage).toBeLessThan(firstPerPage);
    expect(res.body.previews).toEqual([{ phaseGroupId: 9, names: ['Recovered'], total: 1 }]);
  });

  it('keeps a pool whose standing has no entrant yet', async () => {
    gqlMock.mockResolvedValue({
      phase: {
        phaseGroups: {
          pageInfo: { totalPages: 1 },
          nodes: [{ id: 3, standings: { pageInfo: { total: 2 }, nodes: [{ entrant: null }, { entrant: { name: 'Real' } }] } }],
        },
      },
    });
    const cookie = await makeSignedInCookie('pool-preview-null');

    const res = await request(app).get('/api/sets/phase/780/pool-preview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.previews).toEqual([{ phaseGroupId: 3, names: ['Real'], total: 2 }]);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/sets/phase/777/pool-preview');
    expect(res.status).toBe(401);
  });
});

describe('GET /:eventId/entrants', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  function respondWith(nodes: unknown[]) {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventEntrantSearch')) return Promise.resolve({ event: { entrants: { nodes } } });
      throw new Error(`unexpected query in test: ${query}`);
    });
  }

  it('refuses a query too short to mean anything, without asking start.gg', async () => {
    // "a" matches 900 of Supernova's 1581 entrants, so a short query spends a
    // request against an ~80/min per-token limit to answer nothing.
    respondWith([]);
    const cookie = await makeSignedInCookie('entrants-short');

    const res = await request(app).get('/api/sets/12345/entrants?q=sp').set('Cookie', cookie);

    expect(res.status).toBe(400);
    expect(gqlMock).not.toHaveBeenCalled();
  });

  it('treats surrounding whitespace as not making a query longer', async () => {
    respondWith([]);
    const cookie = await makeSignedInCookie('entrants-blank');

    const res = await request(app).get('/api/sets/12345/entrants?q=%20%20a%20%20').set('Cookie', cookie);

    expect(res.status).toBe(400);
    expect(gqlMock).not.toHaveBeenCalled();
  });

  it('returns each match with every pool they were seeded into', async () => {
    respondWith([
      { id: 1, name: 'FaZe | Sparg0', seeds: [{ phaseGroup: { id: 10 } }, { phaseGroup: { id: 20 } }] },
      { id: 2, name: 'JL | Zoruya', seeds: [{ phaseGroup: { id: 11 } }] },
    ]);
    const cookie = await makeSignedInCookie('entrants-match');

    const res = await request(app).get('/api/sets/12345/entrants?q=sparg0').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.entrants).toEqual([
      { id: 1, name: 'FaZe | Sparg0', phaseGroupIds: [10, 20] },
      { id: 2, name: 'JL | Zoruya', phaseGroupIds: [11] },
    ]);
  });

  it('keeps an entrant whose seed has no pool yet, with no pools listed', async () => {
    // A real state while an event is being set up — the player exists, they
    // just have not been drawn into a pool.
    respondWith([{ id: 3, name: 'Undrawn', seeds: [{ phaseGroup: null }] }]);
    const cookie = await makeSignedInCookie('entrants-undrawn');

    const res = await request(app).get('/api/sets/12345/entrants?q=undrawn').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.entrants).toEqual([{ id: 3, name: 'Undrawn', phaseGroupIds: [] }]);
  });

  it('rejects an unauthenticated lookup', async () => {
    const res = await request(app).get('/api/sets/12345/entrants?q=sparg0');
    expect(res.status).toBe(401);
  });
});

describe('GET /:eventId/phase-groups', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  it("lists every pool/bracket in the event, across phases, with no set data", async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventPhaseGroups')) {
        return Promise.resolve({
          event: {
            phaseGroups: [
              { id: 2, displayIdentifier: 'Pool A', bracketType: 'ROUND_ROBIN', phase: { id: 7, name: 'Pools', numSeeds: 32 } },
              { id: 3, displayIdentifier: 'Pool B', bracketType: 'ROUND_ROBIN', phase: { id: 7, name: 'Pools', numSeeds: 32 } },
              { id: 1, displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', phase: { id: 8, name: 'Bracket', numSeeds: 8 } },
            ],
          },
        });
      }
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('phase-groups-list');

    const res = await request(app).get('/api/sets/12345/phase-groups').set('Cookie', cookie);

    expect(res.status).toBe(200);
    const phaseGroups: ResponsePhaseGroupSummary[] = res.body.phaseGroups;
    expect(phaseGroups).toEqual([
      { id: 2, displayIdentifier: 'Pool A', bracketType: 'ROUND_ROBIN', phaseId: 7, phaseName: 'Pools', phaseNumSeeds: 32 },
      { id: 3, displayIdentifier: 'Pool B', bracketType: 'ROUND_ROBIN', phaseId: 7, phaseName: 'Pools', phaseNumSeeds: 32 },
      { id: 1, displayIdentifier: '1', bracketType: 'DOUBLE_ELIMINATION', phaseId: 8, phaseName: 'Bracket', phaseNumSeeds: 8 },
    ]);
  });

  it('reports a phase with no seeds yet as 0 rather than dropping it', async () => {
    // numSeeds is null before a phase is seeded. It sorts last, which is where
    // an unseeded phase belongs, but the pool still has to be pickable.
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventPhaseGroups')) {
        return Promise.resolve({
          event: {
            phaseGroups: [{ id: 4, displayIdentifier: '1', bracketType: 'SINGLE_ELIMINATION', phase: { id: 9, name: 'Top 8', numSeeds: null } }],
          },
        });
      }
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('phase-groups-unseeded');

    const res = await request(app).get('/api/sets/12345/phase-groups').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.phaseGroups).toEqual([
      { id: 4, displayIdentifier: '1', bracketType: 'SINGLE_ELIMINATION', phaseId: 9, phaseName: 'Top 8', phaseNumSeeds: 0 },
    ]);
  });

  it('returns an empty list rather than an error when the event has no phase groups', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventPhaseGroups')) return Promise.resolve({ event: { phaseGroups: [] } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('phase-groups-empty');

    const res = await request(app).get('/api/sets/12345/phase-groups').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.phaseGroups).toEqual([]);
  });
});

function setDetailFixture() {
  return {
    set: {
      games: [
        {
          winnerId: 101,
          orderNum: 1,
          stage: { id: 51 },
          selections: [
            { entrant: { id: 101 }, character: { id: 1273 } },
            { entrant: { id: 102 }, character: { id: 1274 } },
          ],
        },
        {
          winnerId: 102,
          orderNum: 2,
          stage: null,
          selections: [{ entrant: { id: 101 }, character: { id: 1273 } }],
        },
        {
          winnerId: 101,
          orderNum: 3,
          stage: { id: 52 },
          selections: [],
        },
        // Defensively malformed — missing winnerId/orderNum — must be
        // dropped, not surfaced as a broken game or crash the endpoint.
        { winnerId: null, orderNum: null, stage: null, selections: [] },
      ],
    },
  };
}

describe('GET /:setId/detail', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('returns each game in order with its winner, stage, and per-entrant character picks', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('SetDetail')) return Promise.resolve(setDetailFixture());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('set-detail');

    const res = await request(app).get('/api/sets/123456/detail').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.games).toEqual([
      { orderNum: 1, winnerEntrantId: 101, stageId: 51, characterIdByEntrantId: { 101: 1273, 102: 1274 } },
      { orderNum: 2, winnerEntrantId: 102, stageId: null, characterIdByEntrantId: { 101: 1273 } },
      { orderNum: 3, winnerEntrantId: 101, stageId: 52, characterIdByEntrantId: {} },
    ]);
  });

  it('returns an empty games list, not an error, when start.gg has no game records for this set', async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('SetDetail')) return Promise.resolve({ set: { games: [] } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('set-detail-empty');

    const res = await request(app).get('/api/sets/123456/detail').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.games).toEqual([]);
  });
});
