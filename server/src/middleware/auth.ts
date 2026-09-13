import type { Request, Response, NextFunction } from 'express';
import { getSessionWithUser, touchSessionExpiry, isPastHalfLife, deleteSession } from '../db/sessions.js';
import { updateUserTokens } from '../db/users.js';
import { refreshAccessToken, StartggOAuthError } from '../startggOAuth.js';

export interface AuthUser {
  id: number;
  startggUserId: string;
  displayName: string;
  accessToken: string;
}

const SESSION_COOKIE = 'qs_session';
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh a day before the access token actually expires

// De-dupes concurrent refreshes for the same user — several requests can
// land in the same moment right as a token crosses the refresh threshold;
// without this each would independently race start.gg's refresh endpoint.
// A plain in-process Map is enough at Railway's single-instance scale.
const refreshesInFlight = new Map<number, Promise<string>>();

async function ensureFreshAccessToken(userId: number, accessToken: string, refreshToken: string, tokenExpiresAt: Date): Promise<string> {
  if (tokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return accessToken;
  }
  const existing = refreshesInFlight.get(userId);
  if (existing) return existing;

  const refreshing = (async () => {
    try {
      const tokens = await refreshAccessToken(refreshToken);
      await updateUserTokens(userId, tokens);
      return tokens.accessToken;
    } finally {
      refreshesInFlight.delete(userId);
    }
  })();
  refreshesInFlight.set(userId, refreshing);
  return refreshing;
}

/**
 * The session id and how it arrived. A native client has no cookie jar, so it
 * sends the id as a bearer token instead — the id is already 256 bits of
 * opaque randomness from createSession, which is what makes it safe to carry
 * bare. The cookie's signature guards against a browser tampering with a value
 * it can read; it adds nothing to a token a client only ever echoes back.
 *
 * Which one it was still matters, because setting and clearing cookies means
 * nothing to anyone but a browser.
 */
export function readCredential(req: Request): { sessionId: string; fromCookie: boolean } | null {
  const cookie = req.signedCookies?.[SESSION_COOKIE];
  if (typeof cookie === 'string' && cookie.length > 0) return { sessionId: cookie, fromCookie: true };

  // Read off `headers` rather than req.get() so this works against a plain
  // object in tests as well as a real Express request.
  const header = req.headers?.authorization;
  const match = typeof header === 'string' ? /^Bearer[ ]+(\S+)$/i.exec(header) : null;
  return match ? { sessionId: match[1], fromCookie: false } : null;
}

export async function resolveSessionUser(req: Request, res: Response): Promise<AuthUser | null> {
  const credential = readCredential(req);
  if (!credential) return null;
  const { sessionId, fromCookie } = credential;

  const session = await getSessionWithUser(sessionId);
  if (!session) return null;

  let accessToken: string;
  try {
    accessToken = await ensureFreshAccessToken(
      session.user.id,
      session.user.accessToken,
      session.user.refreshToken,
      session.user.tokenExpiresAt
    );
  } catch (err) {
    // Only start.gg actually rejecting the refresh token means the session is
    // unrecoverable. Anything else — a 500, a rate limit, a dropped
    // connection — is temporary, and destroying the session over it would
    // sign a TO out mid-tournament because start.gg hiccupped.
    const rejected = err instanceof StartggOAuthError && (err.status === 400 || err.status === 401);
    // Refreshes start a day before the token actually expires (see
    // REFRESH_MARGIN_MS), so the current one is almost always still usable.
    const currentTokenStillValid = session.user.tokenExpiresAt.getTime() > Date.now();

    if (rejected || !currentTokenStillValid) {
      await deleteSession(sessionId);
      if (fromCookie) res.clearCookie(SESSION_COOKIE);
      return null;
    }

    console.warn(`[auth] token refresh failed for user ${session.user.id}; continuing on the current token:`, err);
    accessToken = session.user.accessToken;
  }

  if (isPastHalfLife(session.sessionExpiresAt)) {
    // The row is what actually extends the session, so a bearer client gets
    // the same sliding expiry — it just has nothing to restamp on its end.
    const newExpiry = await touchSessionExpiry(sessionId);
    if (fromCookie) res.cookie(SESSION_COOKIE, sessionId, cookieOptions(newExpiry));
  }

  return {
    id: session.user.id,
    startggUserId: session.user.startggUserId,
    displayName: session.user.displayName,
    accessToken,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await resolveSessionUser(req, res);
  if (!user) {
    res.status(401).json({ error: 'Not signed in' });
    return;
  }
  req.user = user;
  next();
}

export function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    signed: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    expires,
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
