import { STARTGG_OAUTH_CLIENT_ID, STARTGG_OAUTH_CLIENT_SECRET } from './env.js';

// The authorize step is a browser-navigated, session-cookie-driven flow
// (login + consent UI), which lives on start.gg's main frontend — NOT
// api.start.gg, which has no such UI (confirmed empirically: api.start.gg's
// own /oauth/authorize redirects to a /login page that 404s on that host).
// Token exchange and refresh are plain server-to-server API calls with no
// session/UI involved, so those stay on api.start.gg per start.gg's docs.
const AUTHORIZE_URL = 'https://start.gg/oauth/authorize';
const TOKEN_URL = 'https://api.start.gg/oauth/access_token';
const REFRESH_URL = 'https://api.start.gg/oauth/refresh';

// Scoped to exactly what SmashSet needs: user.identity to resolve who signed
// in, tournament.reporter to report sets for tournaments that user can
// already touch on start.gg — nothing broader.
const SCOPES = 'user.identity tournament.reporter';

function redirectUri(): string {
  return `${process.env.APP_BASE_URL}/api/auth/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: STARTGG_OAUTH_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  // Deliberately no client_secret here — start.gg's own "Example OAuth Flow"
  // doc shows one in this URL, but that's a front-channel browser redirect
  // (exposed in history/referrer/logs); a secret belongs only in the
  // server-to-server token exchange below, never here.
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface TokenResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

/**
 * start.gg answers a refresh it has rejected with **HTTP 200** and the reason
 * as a bare JSON string: `"The refresh token is invalid. Cannot decrypt the
 * refresh token"` (measured directly against api.start.gg/oauth/refresh).
 *
 * So `res.ok` is true, JSON.parse succeeds, and reading access_token off a
 * string gives undefined — a failure that looks exactly like a success until
 * something downstream trips over it. Checking the shape is the only way to
 * tell the two apart here; the status cannot.
 */
function isTokenResponse(body: unknown): body is TokenResponse {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Partial<TokenResponse>;
  return typeof b.access_token === 'string' && typeof b.refresh_token === 'string' && typeof b.expires_in === 'number';
}

/**
 * Whether start.gg is saying this refresh token is finished, as opposed to
 * something temporary. It only tells us in prose, so this reads the prose —
 * and errs toward "temporary", because being wrong that way costs a retry
 * while being wrong the other way signs a TO out mid-tournament.
 */
function saysTokenIsDead(raw: string): boolean {
  return /refresh token is invalid|cannot decrypt|invalid_grant|expired/i.test(raw);
}

function toTokenResult(body: TokenResponse): TokenResult {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}

export async function exchangeCodeForTokens(code: string): Promise<TokenResult> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STARTGG_OAUTH_CLIENT_ID,
      client_secret: STARTGG_OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      scope: SCOPES,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`start.gg token exchange failed (${res.status}): ${raw}`);
  }
  const body = parseBody(raw);
  if (!isTokenResponse(body)) {
    // Same 200-with-an-error-string shape as refresh. Signing somebody in on
    // an undefined access token would hand them a session that cannot talk to
    // start.gg at all.
    throw new Error(`start.gg token exchange returned no tokens (${res.status}): ${raw}`);
  }
  return toTokenResult(body);
}

function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Carries the HTTP status so callers can tell a refresh token start.gg has
// actually rejected (400/401) from start.gg merely being unavailable. Without
// that distinction the only safe-looking option is to destroy the session,
// which turns a momentary outage into a TO being signed out mid-tournament.
export class StartggOAuthError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STARTGG_OAUTH_CLIENT_ID,
      client_secret: STARTGG_OAUTH_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new StartggOAuthError(`start.gg token refresh failed (${res.status}): ${raw}`, res.status);
  }

  const body = parseBody(raw);
  if (!isTokenResponse(body)) {
    // A rejected refresh arrives as 200, so the status carries no information
    // and resolveSessionUser's 400/401 check — which exists precisely to spot
    // a refresh token start.gg has finished with — could never once have
    // fired. Reported as 401 when the body says the token is dead, so that
    // check means what it was written to mean; left as the real status
    // otherwise, which resolveSessionUser treats as temporary and rides out on
    // the access token it already has.
    throw new StartggOAuthError(`start.gg token refresh failed (${res.status}): ${raw}`, saysTokenIsDead(raw) ? 401 : res.status);
  }
  return toTokenResult(body);
}
