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
      json: async () => ({
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
      json: async () => ({
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
});
