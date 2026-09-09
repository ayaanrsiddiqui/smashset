import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';

const gqlMock = vi.fn();
vi.mock('../startgg.js', () => ({
  gql: (...args: unknown[]) => gqlMock(...args),
}));

// Imported after the mock is registered so app.js's import graph — sets.js ->
// startgg.js, and sets.js -> mainLookup.js -> startgg.js — picks up the
// mocked gql instead of hitting start.gg for real. Same ordering
// middleware/auth.test.ts already uses, for the same reason.
const { createApp } = await import('../app.js');
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
    event: {
      videogame: { id: VIDEOGAME_ID },
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
  suggestedMainCharacterId?: number;
}

describe('GET /:eventId/open-sets — auto-main integration', () => {
  afterEach(() => {
    gqlMock.mockReset();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id < 0');
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('attaches suggestedMainCharacterId for a cached player, omits it for an uncached one, and never leaks playerId', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id < 0');
    await pool.query(
      `INSERT INTO player_mains (player_id, videogame_id, character_id, games_tallied, sets_considered)
       VALUES ($1, $2, $3, $4, $5)`,
      [CACHED_PLAYER_ID, VIDEOGAME_ID, CACHED_CHARACTER_ID, 6, 10]
    );
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventOpenSets')) return Promise.resolve(openSetsFixture());
      if (query.includes('PlayerMainHistory')) return Promise.resolve(emptyPlayerHistory());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('attach');
    const eventId = nextTestEventId++; // each test gets its own eventId so fetchOpenSets' 4s cache never crosses tests

    const res = await request(app).get(`/api/sets/${eventId}/open-sets`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    const entrants: ResponseEntrant[] = res.body.sets[0].entrants;
    expect(entrants).toHaveLength(2);
    const cached = entrants.find((e) => e.name === 'Cached Player')!;
    const uncached = entrants.find((e) => e.name === 'Uncached Player')!;
    expect(cached.suggestedMainCharacterId).toBe(CACHED_CHARACTER_ID);
    expect(uncached.suggestedMainCharacterId).toBeUndefined();
    for (const e of entrants) {
      expect(e).not.toHaveProperty('playerId');
    }

    // One call for the open-sets query itself, one for the uncached player's
    // background history lookup — not two of the latter, since the cached
    // entrant must not re-trigger.
    await vi.waitFor(() => expect(gqlMock).toHaveBeenCalledTimes(2));
  });

  it('a background lookup for a real uncached player actually lands in the database as a tombstone when it has no history', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id < 0');
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventOpenSets')) return Promise.resolve(openSetsFixture());
      if (query.includes('PlayerMainHistory')) return Promise.resolve(emptyPlayerHistory());
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('lands-in-db');
    const eventId = nextTestEventId++;

    await request(app).get(`/api/sets/${eventId}/open-sets`).set('Cookie', cookie);

    await vi.waitFor(async () => {
      const { rows } = await pool.query('SELECT character_id FROM player_mains WHERE player_id = $1 AND videogame_id = $2', [
        UNCACHED_PLAYER_ID,
        VIDEOGAME_ID,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].character_id).toBeNull(); // no history in the fixture -> a real tombstone, not "not looked up"
    });
  });

  it('does not block the HTTP response on the background lookup', async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id < 0');
    const releasers: ((v: unknown) => void)[] = [];
    const pendingPlayerHistory = () =>
      new Promise((resolve) => {
        releasers.push(resolve);
      });
    gqlMock.mockImplementation((_token: unknown, query: string) => {
      if (query.includes('EventOpenSets')) return Promise.resolve(openSetsFixture());
      // Both entrants are uncached at this point (player_mains was just
      // cleared above), so both trigger a background lookup — every one of
      // them stays pending until released below.
      if (query.includes('PlayerMainHistory')) return pendingPlayerHistory();
      throw new Error(`unexpected query in test: ${query}`);
    });
    const cookie = await makeSignedInCookie('non-blocking');
    const eventId = nextTestEventId++;

    // If ensureMainComputed were accidentally awaited in the route handler,
    // this request would hang forever (the PlayerMainHistory mocks never
    // resolve until released below) and the test would time out — a direct,
    // automated proof of "must not block," not just an argument for it.
    const res = await request(app).get(`/api/sets/${eventId}/open-sets`).set('Cookie', cookie);
    expect(res.status).toBe(200);

    // Release the pending mocks so both background tasks finish and their
    // in-flight tracking entries don't leak into later tests.
    for (const release of releasers) release(emptyPlayerHistory());
    await vi.waitFor(() => expect(gqlMock).toHaveBeenCalledTimes(1 + releasers.length));
  });
});
