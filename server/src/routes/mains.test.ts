import { afterAll, describe, expect, it } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { getPlayerMains, insertComputedPlayerMain } from '../db/mains.js';
import { closeTestPool } from '../test-helpers.js';
import { testServer } from '../test-server.js';
import { createApp } from '../app.js';

const server = testServer(createApp());

const PREFIX = `test-mains-route-${Date.now()}-`;
const VIDEOGAME_ID = 1386;
const PLAYER_ID = -201;

function futureDate(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

async function makeSignedInCookie(): Promise<string> {
  const user = await upsertUserFromOAuth(`${PREFIX}user`, null, 'Mains Route Test', {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: futureDate(168),
  });
  const session = await createSession(user.id);
  const signed = `s:${sign(session.id, process.env.SESSION_SECRET!)}`;
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`;
}

// File-level, so it runs after every describe below. Closing the pool inside
// one of them ends it for the whole file, and the next describe's first query
// dies on a pool that has already been shut.
afterAll(async () => {
  await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  await closeTestPool();
});

describe('POST /api/mains', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = $1', [PLAYER_ID]);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(server).post('/api/mains').send({ playerId: PLAYER_ID, videogameId: VIDEOGAME_ID, characterId: 1 });
    expect(res.status).toBe(401);
  });

  it('sets a manual main as a real, immediately-queryable row', async () => {
    const cookie = await makeSignedInCookie();
    const res = await request(server)
      .post('/api/mains')
      .set('Cookie', cookie)
      .send({ playerId: PLAYER_ID, videogameId: VIDEOGAME_ID, characterId: 42 });

    expect(res.status).toBe(200);
    expect(res.body.characterId).toBe(42);

    const mains = await getPlayerMains([PLAYER_ID], VIDEOGAME_ID);
    expect(mains.get(PLAYER_ID)?.characterId).toBe(42);
    // No real set history backs a manual correction.
    expect(mains.get(PLAYER_ID)?.gamesTallied).toBe(0);
  });

  it('overwrites an existing main (e.g. one the background auto-lookup previously set)', async () => {
    const cookie = await makeSignedInCookie();
    await request(server).post('/api/mains').set('Cookie', cookie).send({ playerId: PLAYER_ID, videogameId: VIDEOGAME_ID, characterId: 1 });

    const res = await request(server)
      .post('/api/mains')
      .set('Cookie', cookie)
      .send({ playerId: PLAYER_ID, videogameId: VIDEOGAME_ID, characterId: 2 });

    expect(res.status).toBe(200);
    expect(res.body.characterId).toBe(2);
    expect((await getPlayerMains([PLAYER_ID], VIDEOGAME_ID)).get(PLAYER_ID)?.characterId).toBe(2);
  });

  it('accepts a null characterId to clear a wrong guess', async () => {
    const cookie = await makeSignedInCookie();
    await request(server).post('/api/mains').set('Cookie', cookie).send({ playerId: PLAYER_ID, videogameId: VIDEOGAME_ID, characterId: 1 });

    const res = await request(server)
      .post('/api/mains')
      .set('Cookie', cookie)
      .send({ playerId: PLAYER_ID, videogameId: VIDEOGAME_ID, characterId: null });

    expect(res.status).toBe(200);
    expect(res.body.characterId).toBeNull();
  });

  it('rejects a missing playerId or videogameId', async () => {
    const cookie = await makeSignedInCookie();
    const res = await request(server).post('/api/mains').set('Cookie', cookie).send({ videogameId: VIDEOGAME_ID, characterId: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/mains/tallies', () => {
  const TALLY_PLAYER = -202;
  const OTHER_PLAYER = -203;
  // Its own row, so this file's tests do not depend on each other's order —
  // insertComputedPlayerMain declines to touch a row that already exists, so a
  // shared player would quietly serve the first test's tally to the second.
  const PAIRED_PLAYER = -204;

  afterAll(async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = ANY($1)', [[TALLY_PLAYER, OTHER_PLAYER, PAIRED_PLAYER]]);
  });

  it('returns what each player has been playing, keyed by player', async () => {
    await insertComputedPlayerMain(TALLY_PLAYER, VIDEOGAME_ID, 1338, 4, 8, { 1338: 4, 1300: 2 });
    const cookie = await makeSignedInCookie();

    const res = await request(server)
      .get(`/api/mains/tallies?videogameId=${VIDEOGAME_ID}&playerIds=${TALLY_PLAYER}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.tallies[String(TALLY_PLAYER)]).toEqual({ 1338: 4, 1300: 2 });
  });

  it('simply omits a player with no tally yet, rather than failing the request', async () => {
    // One unlooked player must not cost the other their ordering — the panel
    // asks for both entrants at once and a hard failure would flatten both
    // dropdowns back to alphabetical.
    await insertComputedPlayerMain(PAIRED_PLAYER, VIDEOGAME_ID, 1338, 4, 8, { 1338: 4 });
    const cookie = await makeSignedInCookie();

    const res = await request(server)
      .get(`/api/mains/tallies?videogameId=${VIDEOGAME_ID}&playerIds=${PAIRED_PLAYER},${OTHER_PLAYER}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.tallies[String(PAIRED_PLAYER)]).toEqual({ 1338: 4 });
    expect(res.body.tallies[String(OTHER_PLAYER)]).toBeUndefined();
  });

  it('answers an empty list without touching the database', async () => {
    const cookie = await makeSignedInCookie();

    const res = await request(server).get(`/api/mains/tallies?videogameId=${VIDEOGAME_ID}&playerIds=`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.tallies).toEqual({});
  });

  it('refuses a request with no videogame, since a tally is per game', async () => {
    const cookie = await makeSignedInCookie();

    const res = await request(server).get('/api/mains/tallies?playerIds=1').set('Cookie', cookie);

    expect(res.status).toBe(400);
  });

  it('is not readable without a session', async () => {
    const res = await request(server).get(`/api/mains/tallies?videogameId=${VIDEOGAME_ID}&playerIds=1`);

    expect(res.status).toBe(401);
  });
});
