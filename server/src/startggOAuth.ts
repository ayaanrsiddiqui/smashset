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
  if (!res.ok) {
    throw new Error(`start.gg token exchange failed (${res.status}): ${await res.text()}`);
  }
  return toTokenResult((await res.json()) as TokenResponse);
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
  if (!res.ok) {
    throw new Error(`start.gg token refresh failed (${res.status}): ${await res.text()}`);
  }
  return toTokenResult((await res.json()) as TokenResponse);
}
