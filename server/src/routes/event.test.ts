import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';

const gqlMock = vi.fn();
// Only gql is stubbed. parseStartggInput and resolveShortUrl stay real, so
// these tests exercise the actual slug the route ends up querying rather than
// a restatement of the route's own logic.
vi.mock('../startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
}));

const { createApp } = await import('../app.js');
const app = createApp();

const PREFIX = `test-event-route-${Date.now()}-`;

async function makeSignedInCookie(): Promise<string> {
  const user = await upsertUserFromOAuth(`${PREFIX}user`, null, 'Event Route Test', {
    accessToken: 'access',
    refreshToken: 'refresh',
    // Far enough out that the auth middleware never tries to refresh, which
    // would otherwise hit the stubbed fetch below.
    expiresAt: new Date(Date.now() + 168 * 60 * 60 * 1000),
  });
  const session = await createSession(user.id);
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${sign(session.id, process.env.SESSION_SECRET!)}`)}`;
}

const ONE_EVENT = {
  tournament: {
    id: 940971,
    name: 'Supernova 2026',
    events: [{ id: 1, name: 'Ultimate Singles', slug: 'x', videogame: { id: 1386, name: 'Ultimate' } }],
  },
};

/** The slug the route actually asked start.gg about. */
function queriedSlug(): string {
  return gqlMock.mock.calls.at(-1)![2].slug;
}

describe('POST /api/event/resolve', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    gqlMock.mockResolvedValue(ONE_EVENT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    gqlMock.mockReset();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
    await closeTestPool();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/event/resolve').send({ input: 'supernova' });
    expect(res.status).toBe(401);
  });

  it('resolves a bare slug to whatever start.gg/<slug> serves', async () => {
    // The live bug: typing "supernova" used to load SuperNova 2016, because
    // that tournament owns the canonical slug while start.gg/supernova serves
    // Supernova 2026.
    fetchMock.mockResolvedValue({ ok: true, url: 'https://www.start.gg/tournament/supernova-2026/events' });

    const res = await request(app).post('/api/event/resolve').set('Cookie', await makeSignedInCookie()).send({ input: 'supernova' });

    expect(res.status).toBe(200);
    expect(queriedSlug()).toBe('supernova-2026');
  });

  it('leaves an explicit tournament/<slug> alone', async () => {
    // Someone who typed the canonical path asked for that tournament by name,
    // so redirecting them to the short URL's owner would be wrong.
    const res = await request(app)
      .post('/api/event/resolve')
      .set('Cookie', await makeSignedInCookie())
      .send({ input: 'start.gg/tournament/supernova' });

    expect(res.status).toBe(200);
    expect(queriedSlug()).toBe('supernova');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the typed slug when start.gg is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

    const res = await request(app).post('/api/event/resolve').set('Cookie', await makeSignedInCookie()).send({ input: 'uva' });

    // Degraded, not broken: bare slugs that aren't ambiguous still resolve.
    expect(res.status).toBe(200);
    expect(queriedSlug()).toBe('uva');
  });

  it('never short-URL-resolves a full event URL', async () => {
    gqlMock.mockResolvedValue({ event: { id: 9, name: 'Ultimate Singles', slug: 's', videogame: { id: 1386, name: 'U' }, tournament: { id: 1, name: 'T' } } });

    const res = await request(app)
      .post('/api/event/resolve')
      .set('Cookie', await makeSignedInCookie())
      .send({ input: 'https://start.gg/tournament/supernova-2026/event/ultimate-singles' });

    expect(res.status).toBe(200);
    expect(queriedSlug()).toBe('tournament/supernova-2026/event/ultimate-singles');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
