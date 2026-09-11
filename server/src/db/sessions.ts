import { randomBytes } from 'crypto';
import { pool } from './pool.js';
import { decrypt } from '../crypto.js';
import type { StoredUser } from './users.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

interface SessionUserRow {
  session_id: string;
  session_expires_at: Date;
  id: number;
  startgg_user_id: string;
  startgg_slug: string | null;
  display_name: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
  top_x_bo5: number | null;
}

export interface SessionWithUser {
  sessionId: string;
  sessionExpiresAt: Date;
  user: StoredUser;
}

function fromRow(row: SessionUserRow): SessionWithUser {
  return {
    sessionId: row.session_id,
    sessionExpiresAt: row.session_expires_at,
    user: {
      id: row.id,
      startggUserId: row.startgg_user_id,
      startggSlug: row.startgg_slug,
      displayName: row.display_name,
      accessToken: decrypt(row.access_token),
      refreshToken: decrypt(row.refresh_token),
      tokenExpiresAt: row.token_expires_at,
      topXBo5: row.top_x_bo5,
    },
  };
}

export async function createSession(userId: number): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [id, userId, expiresAt]);
  return { id, expiresAt };
}

export async function getSessionWithUser(sessionId: string): Promise<SessionWithUser | null> {
  const { rows } = await pool.query<SessionUserRow>(
    `SELECT s.id AS session_id, s.expires_at AS session_expires_at, u.*
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId]
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

/** Extends a session by the full TTL — call only when it's already past the halfway point, not on every request. */
export async function touchSessionExpiry(sessionId: string): Promise<Date> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [sessionId, expiresAt]);
  return expiresAt;
}

export function isPastHalfLife(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2;
}
