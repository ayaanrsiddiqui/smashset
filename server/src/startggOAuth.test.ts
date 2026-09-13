import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from './startggOAuth.js';
import { STARTGG_OAUTH_CLIENT_ID, STARTGG_OAUTH_CLIENT_SECRET } from './env.js';

describe('buildAuthorizeUrl', () => {
  it('points at start.gg (not api.start.gg — that host has no login UI)', () => {
    const url = new URL(buildAuthorizeUrl('some-state'));
    expect(url.origin).toBe('https://start.gg');
    expect(url.pathname).toBe('/oauth/authorize');
  });

  it('includes response_type=code, the client id, both scopes, the callback redirect_uri, and the given state', () => {
    const url = new URL(buildAuthorizeUrl('csrf-check-123'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(STARTGG_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('user.identity tournament.reporter');
    expect(url.searchParams.get('redirect_uri')).toBe(`${process.env.APP_BASE_URL}/api/auth/callback`);
    expect(url.searchParams.get('state')).toBe('csrf-check-123');
  });

  it('never includes client_secret — that belongs only in the server-to-server exchange', () => {
    const url = new URL(buildAuthorizeUrl('state'));
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(url.toString()).not.toContain(STARTGG_OAUTH_CLIENT_SECRET);
  });
});

describe('exchangeCodeForTokens / refreshAccessToken', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('exchangeCodeForTokens posts to api.start.gg/oauth/access_token with an authorization_code grant', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 604800,
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
        }),
    });

    const before = Date.now();
    const result = await exchangeCodeForTokens('the-auth-code');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.start.gg/oauth/access_token');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      client_id: STARTGG_OAUTH_CLIENT_ID,
      client_secret: STARTGG_OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: 'the-auth-code',
      redirect_uri: `${process.env.APP_BASE_URL}/api/auth/callback`,
    });

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    // expires_in (seconds) converted to an absolute Date ~604800s out.
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 604800 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThan(before + 604900 * 1000);
  });

  it('refreshAccessToken posts to api.start.gg/oauth/refresh with a refresh_token grant', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 604800,
          access_token: 'refreshed-access-token',
          refresh_token: 'refreshed-refresh-token',
        }),
    });

    const result = await refreshAccessToken('the-old-refresh-token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.start.gg/oauth/refresh');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'the-old-refresh-token',
    });
    expect(result.accessToken).toBe('refreshed-access-token');
  });

  it('exchangeCodeForTokens throws with the status and body when start.gg responds non-OK', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    });

    await expect(exchangeCodeForTokens('bad-code')).rejects.toThrow(/400/);
  });

  it('refreshAccessToken throws when start.gg responds non-OK (e.g. a revoked refresh token)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_grant"}',
    });

    await expect(refreshAccessToken('dead-refresh-token')).rejects.toThrow(/401/);
  });

  // The shape start.gg really returns for a refresh it will not honour,
  // copied from a live call to api.start.gg/oauth/refresh: HTTP 200, and the
  // reason as a bare JSON string. The test above this one mocks 401, which is
  // a response start.gg has never been observed to send.
  const LIVE_REJECTION = '"The refresh token is invalid. Cannot decrypt the refresh token"';

  it('treats start.gg\'s 200-with-an-error-string as the failure it is, not a token', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => LIVE_REJECTION });

    // Before: res.ok was true, so this resolved to { accessToken: undefined,
    // refreshToken: undefined, expiresAt: Invalid Date } and the caller stored it.
    await expect(refreshAccessToken('dead-refresh-token')).rejects.toThrow(/refresh token is invalid/i);
  });

  it('reports a dead refresh token as 401, so the session check that looks for one can fire', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => LIVE_REJECTION });

    // resolveSessionUser only ends a session on 400/401. Since start.gg says
    // 200, that branch could never run — the session limped on its old access
    // token until it expired, and the user had to approve the app again.
    await expect(refreshAccessToken('dead-refresh-token')).rejects.toMatchObject({ status: 401 });
  });

  it('leaves a 200 that says nothing about the token being dead as retryable', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '"Service temporarily unavailable"' });

    // Not 401: resolveSessionUser rides this out on the access token it already
    // has rather than signing a TO out because start.gg hiccupped.
    await expect(refreshAccessToken('good-refresh-token')).rejects.toMatchObject({ status: 200 });
  });

  it('still accepts a real token response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ token_type: 'Bearer', expires_in: 604800, access_token: 'new-access', refresh_token: 'new-refresh' }),
    });

    const tokens = await refreshAccessToken('good-refresh-token');
    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.refreshToken).toBe('new-refresh');
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to sign somebody in on an exchange that returned no tokens', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '"Invalid authorization code"' });

    await expect(exchangeCodeForTokens('stale-code')).rejects.toThrow(/returned no tokens/);
  });
});
