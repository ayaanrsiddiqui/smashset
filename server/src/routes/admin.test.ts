import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { sign } from 'cookie-signature';
import request from 'supertest';
import { pool } from '../db/pool.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession } from '../db/sessions.js';
import { recordSetReport, saveReportBracket } from '../db/reports.js';
import { SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { closeTestPool } from '../test-helpers.js';
import { testServer } from '../test-server.js';
import { createApp } from '../app.js';

const server = testServer(createApp());
const PREFIX = `test-admin-${Date.now()}-`;
const PHASE_GROUP = `admin-test-pg-${Date.now()}`;
const ORIGINAL_ADMINS = process.env.ADMIN_STARTGG_USER_IDS;

/** Signs in a user whose start.gg id is PREFIX + label. */
async function signIn(label: string): Promise<{ cookie: string; userId: number; startggId: string }> {
  const startggId = `${PREFIX}${label}`;
  const user = await upsertUserFromOAuth(startggId, null, `Admin Test (${label})`, {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 168 * 60 * 60 * 1000),
  });
  const session = await createSession(user.id);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(`s:${sign(session.id, process.env.SESSION_SECRET!)}`)}`,
    userId: user.id,
    startggId,
  };
}

afterEach(() => {
  if (ORIGINAL_ADMINS === undefined) delete process.env.ADMIN_STARTGG_USER_IDS;
  else process.env.ADMIN_STARTGG_USER_IDS = ORIGINAL_ADMINS;
});

afterAll(async () => {
  await pool.query('DELETE FROM set_reports WHERE phase_group_id = $1', [PHASE_GROUP]);
  await pool.query('DELETE FROM report_brackets WHERE phase_group_id = $1', [PHASE_GROUP]);
  await pool.query('DELETE FROM users WHERE startgg_user_id LIKE $1', [`${PREFIX}%`]);
  await closeTestPool();
});

describe('GET /api/admin/reports', () => {
  it('turns everyone away when no admin is configured', async () => {
    // Fails closed. The page shows which account reported which set where, so
    // an unset variable must mean nobody, never everybody.
    delete process.env.ADMIN_STARTGG_USER_IDS;
    const { cookie } = await signIn('unset');

    const res = await request(server).get('/api/admin/reports').set('Cookie', cookie);

    expect(res.status).toBe(403);
  });

  it('turns away a signed-in TO who is not an admin', async () => {
    const admin = await signIn('the-admin');
    const other = await signIn('a-to');
    process.env.ADMIN_STARTGG_USER_IDS = admin.startggId;

    const res = await request(server).get('/api/admin/reports').set('Cookie', other.cookie);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/reportedSets|brackets/);
  });

  it('asks a visitor with no session to sign in, rather than revealing the page exists', async () => {
    process.env.ADMIN_STARTGG_USER_IDS = `${PREFIX}anyone`;

    const res = await request(server).get('/api/admin/reports');

    expect(res.status).toBe(401);
  });

  it('shows an admin every reported set, grouped by bracket, from the real tables', async () => {
    const admin = await signIn('reader');
    process.env.ADMIN_STARTGG_USER_IDS = ` ${PREFIX}someone-else , ${admin.startggId} `;
    await saveReportBracket({
      phaseGroupId: PHASE_GROUP,
      displayIdentifier: '1',
      phaseName: 'Bracket',
      eventId: '1721566',
      eventName: 'BMS Melee Singles',
      tournamentId: '958782',
      tournamentName: 'Bring More Setups 218',
      tournamentSlug: 'tournament/bring-more-setups-218',
      totalSets: 58,
    });
    for (const [setId, open] of [['s1', 5000], ['s2', 7000]] as const) {
      await recordSetReport({
        setId: `${PHASE_GROUP}-${setId}`,
        phaseGroupId: PHASE_GROUP,
        userId: admin.userId,
        winnerEntrantId: '1',
        loserEntrantId: '2',
        winnerName: 'Ada',
        loserName: 'mudd',
        winnerScore: 2,
        loserScore: 0,
        games: 2,
        winnerCharacterGames: 2,
        loserCharacterGames: 2,
        attempt: 1,
        alreadyOnFile: false,
        openToReportMs: open,
        deliveryMs: 400,
        source: 'server',
      });
    }

    const res = await request(server).get('/api/admin/reports').set('Cookie', admin.cookie);

    expect(res.status).toBe(200);
    const bracket = res.body.brackets.find((b: { phaseGroupId: string }) => b.phaseGroupId === PHASE_GROUP);
    expect(bracket).toMatchObject({ tournamentName: 'Bring More Setups 218', eventName: 'BMS Melee Singles', totalSets: 58 });
    expect(bracket.summary).toMatchObject({ reportedSets: 2, medianOpenToReportMs: 6000, bothCharacters: 2 });
    expect(bracket.sets[0]).toMatchObject({ winnerName: 'Ada', loserName: 'mudd', reporter: 'Admin Test (reader)' });
  });
});

describe('GET /api/me', () => {
  it('tells the client an admin is one, so it can offer the link', async () => {
    const admin = await signIn('me-admin');
    process.env.ADMIN_STARTGG_USER_IDS = admin.startggId;

    const res = await request(server).get('/api/me').set('Cookie', admin.cookie);

    expect(res.body.user.isAdmin).toBe(true);
  });

  it('tells everyone else they are not', async () => {
    const admin = await signIn('me-other-admin');
    const other = await signIn('me-not-admin');
    process.env.ADMIN_STARTGG_USER_IDS = admin.startggId;

    const res = await request(server).get('/api/me').set('Cookie', other.cookie);

    expect(res.body.user.isAdmin).toBe(false);
  });
});
