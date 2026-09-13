import { Router } from 'express';
import { randomBytes } from 'crypto';
import { gql } from '../startgg.js';
import { buildAuthorizeUrl, exchangeCodeForTokens } from '../startggOAuth.js';
import { upsertUserFromOAuth } from '../db/users.js';
import { createSession, deleteSession } from '../db/sessions.js';
import { createAuthCode, redeemAuthCode } from '../db/authCodes.js';
import { cookieOptions, readCredential, SESSION_COOKIE_NAME } from '../middleware/auth.js';
import { FRONTEND_URL } from '../env.js';

export const authRouter = Router();

const STATE_COOKIE = 'qs_oauth_state';

// Where the iOS app is handed its one-time code. Registered by the app as a
// custom URL scheme; ASWebAuthenticationSession intercepts it rather than
// letting it reach a browser.
const IOS_CALLBACK_URL = 'smashset://auth';

type Client = 'web' | 'ios';

/**
 * Which client started this sign-in, carried inside `state` rather than in a
 * cookie of its own. `state` is already compared against its signed cookie
 * before anything reads it, so the suffix arrives validated for free — and a
 * second cookie is a second thing to go missing on a redirect chain.
 */
function encodeState(nonce: string, client: Client): string {
  return `${nonce}.${client}`;
}

function clientFromState(state: string): Client {
  return state.endsWith('.ios') ? 'ios' : 'web';
}

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

authRouter.get('/login', (req, res) => {
  const client: Client = req.query.client === 'ios' ? 'ios' : 'web';
  const state = encodeState(randomBytes(16).toString('hex'), client);
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

    if (clientFromState(state) === 'ios') {
      // No cookie: this redirect lands in the app, not a browser. The session
      // id itself stays out of the URL — see the auth_codes migration.
      const authCode = await createAuthCode(session.id);
      res.redirect(`${IOS_CALLBACK_URL}?code=${encodeURIComponent(authCode)}`);
      return;
    }

    res.cookie(SESSION_COOKIE_NAME, session.id, cookieOptions(session.expiresAt));
    res.redirect(FRONTEND_URL);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(502).send(`Sign-in failed: ${message}. Close this tab and try again.`);
  }
});

/**
 * Trades the one-time code from the iOS redirect for the session it stands for.
 *
 * Deliberately unauthenticated: the code *is* the credential. It is 256 bits
 * of randomness, it expires in a minute, and redeeming it destroys the row —
 * so there is nothing here worth guessing at and nothing worth replaying.
 */
authRouter.post('/exchange', async (req, res) => {
  const code = (req.body as { code?: unknown } | undefined)?.code;
  if (typeof code !== 'string' || code.length === 0) {
    res.status(400).json({ error: 'Missing code' });
    return;
  }

  const redeemed = await redeemAuthCode(code);
  if (!redeemed) {
    // Spent, expired, and never-issued deliberately give one answer: telling
    // them apart would confirm whether a given code was ever real.
    res.status(400).json({ error: 'That sign-in has already been used or has expired. Sign in again.' });
    return;
  }

  res.json({ sessionId: redeemed.sessionId, expiresAt: redeemed.expiresAt.toISOString() });
});

authRouter.post('/logout', async (req, res) => {
  // Cookie or bearer — a native client signs out through the same route, it
  // just has no cookie for the clear below to act on.
  const sessionId = readCredential(req)?.sessionId;
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
