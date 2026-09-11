import { Router } from 'express';
import { randomBytes } from 'crypto';
import { gql } from '../startgg.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../startggOAuth.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession, deleteSession } from '../db/sessions.js';
import { cookieOptions, SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { FRONTEND_URL } from '../env.js';

export const authRouter = Router();

const STATE_COOKIE = 'qs_oauth_state';

const CURRENT_USER_QUERY = /* GraphQL */ `
  query CurrentUser {
    currentUser {
      id
      slug
      player {
        gamerTag
      }
    }
  }
`;

interface CurrentUserResult {
  currentUser: {
    id: number;
    slug: string;
    player: { gamerTag: string } | null;
  } | null;
}

authRouter.get('/login', (_req, res) => {
  const state = randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
    path: '/api/auth',
  });
  res.redirect(buildAuthorizeUrl(state));
});

authRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.signedCookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/api/auth' });

  if (typeof code !== 'string' || typeof state !== 'string' || !expectedState || state !== expectedState) {
    res.status(400).send('Sign-in failed: invalid or expired state. Close this tab and try again.');
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const { currentUser } = await gql<CurrentUserResult>(tokens.accessToken, CURRENT_USER_QUERY, {});
    if (!currentUser) {
      throw new Error('start.gg did not return a currentUser for this token');
    }

    const displayName = currentUser.player?.gamerTag ?? currentUser.slug;
    const user = await upsertUserFromOAuth(String(currentUser.id), currentUser.slug, displayName, tokens);
    const session = await createSession(user.id);

    res.cookie(SESSION_COOKIE_NAME, session.id, cookieOptions(session.expiresAt));
    res.redirect(FRONTEND_URL);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(502).send(`Sign-in failed: ${message}. Close this tab and try again.`);
  }
});

authRouter.post('/logout', async (req, res) => {
  const sessionId = req.signedCookies?.[SESSION_COOKIE_NAME];
  // Cookie first: if deleting the row throws, this used to leave both the
  // cookie and the session row intact while the UI showed signed-out — so the
  // next page load was quietly signed back in.
  res.clearCookie(SESSION_COOKIE_NAME);
  try {
    if (sessionId) await deleteSession(sessionId);
  } catch (err) {
    console.error('[auth] failed to delete session on logout:', err);
    res.status(500).json({ error: 'Signed out on this device, but the session could not be ended on the server.' });
    return;
  }
  res.json({ ok: true });
});
