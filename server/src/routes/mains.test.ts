import { afterAll, describe, expect, it } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { getPlayerMains } from '../db/mains.js';
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

describe('POST /api/mains', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM player_mains WHERE player_id = $1', [PLAYER_ID]);
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
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
