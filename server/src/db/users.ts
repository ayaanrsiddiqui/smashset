import { pool } from './pool.js';
import { encrypt, decrypt } from '../crypto.js';

export interface StoredUser {
  id: number;
  startggUserId: string;
  startggSlug: string | null;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: Date;
  topXBo5: number | null;
}

interface UserRow {
  id: number;
  startgg_user_id: string;
  startgg_slug: string | null;
  display_name: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: Date;
  top_x_bo5: number | null;
}

function fromRow(row: UserRow): StoredUser {
  return {
    id: row.id,
    startggUserId: row.startgg_user_id,
    startggSlug: row.startgg_slug,
    displayName: row.display_name,
    accessToken: decrypt(row.access_token),
    refreshToken: decrypt(row.refresh_token),
    tokenExpiresAt: row.token_expires_at,
    topXBo5: row.top_x_bo5,
  };
}

export async function getUserById(id: number): Promise<StoredUser | null> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getUserByStartggId(startggUserId: string): Promise<StoredUser | null> {
  const { rows } = await pool.query<UserRow>('SELECT * FROM users WHERE startgg_user_id = $1', [startggUserId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function upsertUserFromOAuth(
  startggUserId: string,
  startggSlug: string | null,
  displayName: string,
  tokens: OAuthTokens
): Promise<StoredUser> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (startgg_user_id, startgg_slug, display_name, access_token, refresh_token, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (startgg_user_id) DO UPDATE SET
       startgg_slug = EXCLUDED.startgg_slug,
       display_name = EXCLUDED.display_name,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = now()
     RETURNING *`,
    [
      startggUserId,
      startggSlug,
      displayName,
      encrypt(tokens.accessToken),
      encrypt(tokens.refreshToken),
      tokens.expiresAt,
    ]
  );
  return fromRow(rows[0]);
}

export async function updateUserTokens(userId: number, tokens: OAuthTokens): Promise<void> {
  await pool.query(
    `UPDATE users SET access_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now()
     WHERE id = $1`,
    [userId, encrypt(tokens.accessToken), encrypt(tokens.refreshToken), tokens.expiresAt]
  );
}

export async function updateUserTopXBo5(userId: number, topXBo5: number | null): Promise<StoredUser | null> {
  const { rows } = await pool.query<UserRow>(
    'UPDATE users SET top_x_bo5 = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [userId, topXBo5]
  );
  return rows[0] ? fromRow(rows[0]) : null;
}
