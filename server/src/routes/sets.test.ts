import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { upsertPlayerMain } from '../db/mains.js';
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
const { COST_MODEL, invalidateSetCaches } = await import('./sets.js');
const { hasSeenPool, resetPoolEvents } = await import('../poolEvents.js');
const { resetMainLookupState } = await import('../mainLookup.js');
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
      // The report route reads the set before writing to it; see report.ts.
      if (query.includes('ReportPrecondition')) {
        return Promise.resolve({
          set: { id: 5001, state: 2, winnerId: null, slots: [{ entrant: { id: 6001, name: 'A' } }, { entrant: { id: 6002, name: 'B' } }] },
        });
      }
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
function bracketFixture(displayScore = 'Winner Player 2 - Loser Player 0') {
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
            displayScore,
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

const FOX = 1500;
const FALCO = 1501;

/**
 * The per-game character walk. Set 7001 is the completed one; 7002 is not
 * finished, so start.gg carries no games for it.
 */
function charactersFixture(games: unknown = undefined) {
  return {
    phaseGroup: {
      id: 1,
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      phase: { name: 'Bracket' },
      sets: {
        pageInfo: { total: 2, totalPages: 1 },
        nodes: [
          {
            id: 7001,
            winnerId: 8001,
            displayScore: 'Winner Player 2 - Loser Player 0',
            games: games ?? [
              { orderNum: 1, selections: [{ entrant: { id: 8001 }, selectionValue: FOX }, { entrant: { id: 8002 }, selectionValue: FALCO }] },
              { orderNum: 2, selections: [{ entrant: { id: 8001 }, selectionValue: FOX }, { entrant: { id: 8002 }, selectionValue: FALCO }] },
            ],
          },
          { id: 7002, winnerId: null, displayScore: null, games: [] },
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
  characterId: number | null;
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

describe('GET /phase-group/:phaseGroupId/players', () => {
  const VIDEOGAME_ID = 1386;
  // Each test takes its own ids. A background main lookup is fire-and-forget,
  // so one started by an earlier test can write player_mains in the middle of
  // a later one — and overwrite the very row that test is asserting on.
  let idBase = -300;
  let SEEDED_WITH_MAIN = idBase;
  let SEEDED_NO_MAIN_FOUND = idBase - 1;
  let SEEDED_NEVER_LOOKED = idBase - 2;

  function freshIds() {
    idBase -= 10;
    SEEDED_WITH_MAIN = idBase;
    SEEDED_NO_MAIN_FOUND = idBase - 1;
    SEEDED_NEVER_LOOKED = idBase - 2;
  }

  function playersFixture(totalPages = 1, page = 1) {
    const all = [
      { entrant: { id: 9001, name: 'Has Main', participants: [{ player: { id: SEEDED_WITH_MAIN } }] } },
      { entrant: { id: 9002, name: 'Looked Up Empty', participants: [{ player: { id: SEEDED_NO_MAIN_FOUND } }] } },
      { entrant: { id: 9003, name: 'Never Looked', participants: [{ player: { id: SEEDED_NEVER_LOOKED } }] } },
    ];
    return {
      phaseGroup: {
        phase: { event: { videogame: { id: VIDEOGAME_ID } } },
        seeds: { pageInfo: { totalPages }, nodes: totalPages === 1 ? all : [all[page - 1]] },
      },
    };
  }

  beforeEach(async () => {
    // Earlier tests leave lookups holding concurrency slots their mocks never
    // release, so without this the lookup below waits for a slot forever.
    resetMainLookupState();
    freshIds();
    // Also cleared up front, not only afterwards: a fire-and-forget lookup can
    // finish writing its row *after* the afterEach delete, leaving it behind
    // for the next run of this file — which then reads a main where the test
    // expects none.
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [
      [SEEDED_WITH_MAIN, SEEDED_NO_MAIN_FOUND, SEEDED_NEVER_LOOKED],
    ]);
  });

  afterEach(async () => {
    gqlMock.mockReset();
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [
      [SEEDED_WITH_MAIN, SEEDED_NO_MAIN_FOUND, SEEDED_NEVER_LOOKED],
    ]);
  });

  it('returns everyone seeded into the pool, with the main on file for each', async () => {
    await upsertPlayerMain(SEEDED_WITH_MAIN, VIDEOGAME_ID, 1286, 7, 3);
    // Looked up and genuinely found nothing — a different fact from never
    // having looked, and the panel says something different for each.
    await upsertPlayerMain(SEEDED_NO_MAIN_FOUND, VIDEOGAME_ID, null, 0, 5);
    gqlMock.mockImplementation((_t: unknown, query: string) => {
      if (query.includes('PhaseGroupPlayers')) return Promise.resolve(playersFixture());
      // Fire-and-forget lookups from an earlier test can land mid-request.
      if (query.includes('PlayerMainHistory')) return Promise.resolve({ player: { sets: { nodes: [] } } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('pool-players');

    const res = await request(app).get('/api/sets/phase-group/55/players').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.videogameId).toBe(VIDEOGAME_ID);
    expect(res.body.players).toEqual([
      { playerId: SEEDED_WITH_MAIN, name: 'Has Main', main: { characterId: 1286, gamesTallied: 7, setsConsidered: 3 } },
      { playerId: SEEDED_NO_MAIN_FOUND, name: 'Looked Up Empty', main: { characterId: null, gamesTallied: 0, setsConsidered: 5 } },
      { playerId: SEEDED_NEVER_LOOKED, name: 'Never Looked', main: null },
    ]);
  });

  it('reads the roster once but the mains every time', async () => {
    gqlMock.mockImplementation((_t: unknown, query: string) => {
      if (query.includes('PhaseGroupPlayers')) return Promise.resolve(playersFixture());
      // Fire-and-forget lookups from an earlier test can land mid-request.
      if (query.includes('PlayerMainHistory')) return Promise.resolve({ player: { sets: { nodes: [] } } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('pool-players-cache');

    await request(app).get('/api/sets/phase-group/56/players').set('Cookie', cookie);
    const afterFirst = gqlMock.mock.calls.length;
    // A TO sets one between the two calls.
    await upsertPlayerMain(SEEDED_NEVER_LOOKED, VIDEOGAME_ID, 1300, 0, 0);
    const res = await request(app).get('/api/sets/phase-group/56/players').set('Cookie', cookie);

    // Which entrant is which player cannot change once a pool is seeded, so
    // asking start.gg again would be waste — but the mains do change.
    expect(gqlMock.mock.calls.length).toBe(afterFirst);
    expect(res.body.players.find((p: { playerId: number }) => p.playerId === SEEDED_NEVER_LOOKED).main.characterId).toBe(1300);
  });

  it('pages a pool with more seeds than fit in one request', async () => {
    gqlMock.mockImplementation((_t: unknown, query: string, vars: { page: number }) => {
      if (query.includes('PhaseGroupPlayers')) return Promise.resolve(playersFixture(3, vars.page));
      // Fire-and-forget lookups from an earlier test can land mid-request.
      if (query.includes('PlayerMainHistory')) return Promise.resolve({ player: { sets: { nodes: [] } } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('pool-players-paged');

    const res = await request(app).get('/api/sets/phase-group/57/players').set('Cookie', cookie);

    expect(res.body.players).toHaveLength(3);
    // Background main lookups land in the same mock; only the roster query
    // pages, so only its calls are the subject here.
    const rosterPages = gqlMock.mock.calls.filter((c) => String(c[1]).includes('PhaseGroupPlayers')).map((c) => c[2].page);
    expect(rosterPages).toEqual([1, 2, 3]);
  });

  it('skips a seed with no entrant drawn into it yet', async () => {
    gqlMock.mockResolvedValue({
      phaseGroup: {
        phase: { event: { videogame: { id: VIDEOGAME_ID } } },
        seeds: {
          pageInfo: { totalPages: 1 },
          nodes: [{ entrant: null }, { entrant: { id: 9001, name: 'Real', participants: [{ player: { id: SEEDED_WITH_MAIN } }] } }],
        },
      },
    });
    const cookie = await makeSignedInCookie('pool-players-empty-seed');

    const res = await request(app).get('/api/sets/phase-group/58/players').set('Cookie', cookie);

    expect(res.body.players.map((p: { name: string }) => p.name)).toEqual(['Real']);
  });

  it('starts a lookup only for players nobody has checked yet', async () => {
    await upsertPlayerMain(SEEDED_WITH_MAIN, VIDEOGAME_ID, 1286, 7, 3);
    // Looked up before and genuinely found nothing. Asking again every time
    // the panel opens would spend a request to re-learn the same answer.
    await upsertPlayerMain(SEEDED_NO_MAIN_FOUND, VIDEOGAME_ID, null, 0, 5);

    const lookedUp: number[] = [];
    gqlMock.mockImplementation((_t: unknown, query: string, vars: { playerId?: number }) => {
      if (query.includes('PhaseGroupPlayers')) return Promise.resolve(playersFixture());
      if (query.includes('PlayerMainHistory')) {
        lookedUp.push(Number(vars.playerId));
        return Promise.resolve({ player: { sets: { nodes: [] } } });
      }
      // Fire-and-forget lookups from an earlier test can land mid-request.
      if (query.includes('PlayerMainHistory')) return Promise.resolve({ player: { sets: { nodes: [] } } });
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('pool-players-lookup');

    const res = await request(app).get('/api/sets/phase-group/59/players').set('Cookie', cookie);
    expect(res.status).toBe(200);

    // Fire-and-forget, so the response does not wait on start.gg — the work
    // lands afterwards, bounded by ensureMainComputed's own concurrency cap.
    // Asserted per player rather than as a whole list: fire-and-forget lookups
    // started by earlier tests land in this same mock, and they are not the
    // subject here.
    await vi.waitFor(() => expect(lookedUp).toContain(SEEDED_NEVER_LOOKED));
    expect(lookedUp).not.toContain(SEEDED_WITH_MAIN);
    expect(lookedUp).not.toContain(SEEDED_NO_MAIN_FOUND);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/sets/phase-group/55/players');
    expect(res.status).toBe(401);
  });
});

describe('GET /phase-group/:phaseGroupId/events', () => {
  afterEach(() => {
    gqlMock.mockReset();
    resetPoolEvents();
  });

  it('refuses a pool the TO has not read, so a ping cannot reveal one', async () => {
    // Even a data-free "this pool changed" says a tournament exists and just
    // moved, which start.gg may not have shown them.
    const cookie = await makeSignedInCookie('events-unseen');

    const res = await request(app).get('/api/sets/phase-group/999/events').set('Cookie', cookie);

    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated subscriber', async () => {
    const res = await request(app).get('/api/sets/phase-group/1/events');
    expect(res.status).toBe(401);
  });

  it('admits a TO once start.gg has served them that pool', async () => {
    gqlMock.mockImplementation((_t: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve(bracketFixture());
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('events-seen');
    const { rows } = await pool.query('SELECT id FROM users WHERE startgg_user_id = $1', [idFor('events-seen')]);
    const userId: number = rows[0].id;

    expect(hasSeenPool(userId, '1')).toBe(false);
    await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);

    // Reading it with their own token is the admission: the stream itself is
    // long-lived, so the gate is asserted rather than the socket.
    expect(hasSeenPool(userId, '1')).toBe(true);
  });
});

describe('GET /phase-group/:phaseGroupId/bracket', () => {
  /**
   * The character walk is deliberately not on a clock — a finished set's games
   * cannot change unless someone corrects it — so these count the calls rather
   * than only checking the output.
   */
  function countingMock(score?: string) {
    const calls = { characters: 0 };
    gqlMock.mockImplementation((_t: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve(bracketFixture(score));
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (query.includes('PhaseGroupSetCharacters')) {
        calls.characters += 1;
        return Promise.resolve(charactersFixture());
      }
      throw new Error(`unexpected query in test: ${query}`);
    });
    return calls;
  }

  it('shows each entrant the character they played, and nothing where start.gg has none', async () => {
    countingMock();
    const cookie = await makeSignedInCookie('bracket-characters');

    const res = await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);

    const group: ResponseBracketGroup = res.body;
    const completed = group.sets.find((s) => s.id === 7001)!;
    expect(completed.slots[0].characterId).toBe(FOX);
    expect(completed.slots[1].characterId).toBe(FALCO);
    // Unfinished, so there are no games to read a character from.
    expect(group.sets.find((s) => s.id === 7002)!.slots[0].characterId).toBeNull();
  });

  it('walks the pool for characters once, not on every poll', async () => {
    const calls = countingMock();
    const cookie = await makeSignedInCookie('bracket-characters-once');

    await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);
    invalidateSetCaches(); // as a mutation would, forcing a real second fetch
    const res = await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);

    // The bracket really was re-fetched, and the characters were not: they are
    // the same games, and paying ~20 objects a set for them again is the cost
    // this whole design exists to avoid.
    expect(res.body.sets.find((s: ResponseBracketSet) => s.id === 7001)!.slots[0].characterId).toBe(FOX);
    expect(calls.characters).toBe(1);
  });

  it('re-reads characters once a set stops matching what was cached', async () => {
    const calls = countingMock();
    const cookie = await makeSignedInCookie('bracket-characters-corrected');

    await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);
    // Another TO corrects the set on start.gg: same set, different result. The
    // live query already carries the score, so this is noticed for free.
    countingMockScore(calls, 'Winner Player 3 - Loser Player 1');
    invalidateSetCaches();
    await request(app).get('/api/sets/phase-group/1/bracket').set('Cookie', cookie);

    expect(calls.characters).toBe(2);
  });

  function countingMockScore(calls: { characters: number }, score: string) {
    gqlMock.mockImplementation((_t: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve(bracketFixture(score));
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (query.includes('PhaseGroupSetCharacters')) {
        calls.characters += 1;
        return Promise.resolve(charactersFixture());
      }
      throw new Error(`unexpected query in test: ${query}`);
    });
  }

  afterEach(() => {
    gqlMock.mockReset();
  });

  it("returns one phase group's full bracket — completed scores, TBD slots via prereqSetId/prereqPlacement, and cross-phase progression links", async () => {
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('PhaseGroupBracket')) return Promise.resolve(bracketFixture());
      if (query.includes('PhaseGroupProgression')) return Promise.resolve(structureFixture());
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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
      if (query.includes('PhaseGroupSetCharacters')) return Promise.resolve(charactersFixture());
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

  // A phase far larger than any real one, which is the case a fixed page size
  // would quietly fail on.
  function hugePhase(pools: number, costPerPool: number, seen: number[]) {
    return (_t: unknown, _q: string, vars: { page: number; perPage: number }) => {
      seen.push(vars.perPage);
      const cost = COST_MODEL.poolPreview.base + vars.perPage * costPerPool;
      if (cost > 1000) throw new StartggComplexityError(`Your query complexity is too high. (actual: ${cost})`, cost);
      const start = (vars.page - 1) * vars.perPage;
      const nodes = Array.from({ length: Math.max(0, Math.min(vars.perPage, pools - start)) }, (_, i) => ({
        id: start + i + 1,
        standings: { pageInfo: { total: 4 }, nodes: [{ entrant: { name: `P${start + i + 1}` } }] },
      }));
      return Promise.resolve({ phase: { phaseGroups: { pageInfo: { totalPages: Math.ceil(pools / vars.perPage) }, nodes } } });
    };
  }

  it('splits a phase with far more pools than one request can hold', async () => {
    const seen: number[] = [];
    gqlMock.mockImplementation(hugePhase(250, COST_MODEL.poolPreview.maxPerPool, seen));
    const cookie = await makeSignedInCookie('pool-preview-huge');

    const res = await request(app).get('/api/sets/phase/781/pool-preview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    // Every pool, none dropped, across however many requests that took.
    expect(res.body.previews).toHaveLength(250);
    expect(seen.length).toBeGreaterThan(1);
    for (const perPage of seen) {
      expect(COST_MODEL.poolPreview.base + perPage * COST_MODEL.poolPreview.maxPerPool).toBeLessThanOrEqual(1000);
    }
  });

  it('recovers everything when pools cost more than the model says', async () => {
    // The failure the cost model cannot see coming: start.gg adds a field, or
    // the measurement goes stale, and the derived page size is now too big.
    const seen: number[] = [];
    gqlMock.mockImplementation(hugePhase(150, 30, seen));
    const cookie = await makeSignedInCookie('pool-preview-drift');

    const res = await request(app).get('/api/sets/phase/782/pool-preview').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.previews).toHaveLength(150);
    // It asked too big once, was told so, and came back under the cap.
    expect(seen[0]).toBeGreaterThan(seen[seen.length - 1]);
    expect(COST_MODEL.poolPreview.base + seen[seen.length - 1] * 30).toBeLessThanOrEqual(1000);
  });

  it('gives up rather than looping when even one pool is too complex', async () => {
    let calls = 0;
    gqlMock.mockImplementation(() => {
      calls += 1;
      throw new StartggComplexityError('Your query complexity is too high. (actual: 5000)', 5000);
    });
    const cookie = await makeSignedInCookie('pool-preview-hopeless');

    const res = await request(app).get('/api/sets/phase/783/pool-preview').set('Cookie', cookie);

    // Nothing can make a single pool fit, so it has to stop. The page size
    // strictly decreases every retry, which is what makes that terminate.
    expect(res.status).toBe(502);
    expect(calls).toBeLessThan(15);
  });

  it('stops walking a phase that claims an absurd number of pools', async () => {
    const seen: number[] = [];
    gqlMock.mockImplementation(hugePhase(100_000, COST_MODEL.poolPreview.maxPerPool, seen));
    const cookie = await makeSignedInCookie('pool-preview-runaway');

    const res = await request(app).get('/api/sets/phase/784/pool-preview').set('Cookie', cookie);

    // Rows past the cap fall back to showing the bracket type, which still
    // works — far better than hundreds of requests against an 80/minute limit.
    expect(res.status).toBe(200);
    expect(res.body.previews.length).toBeLessThanOrEqual(COST_MODEL.poolPreview.maxPools + 99);
    expect(seen.length).toBeLessThan(12);
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
