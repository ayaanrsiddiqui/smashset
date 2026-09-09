import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMe, logout, resolveEvent } from './api';

describe('api req() wrapper (via fetchMe/logout/resolveEvent)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('fetchMe calls GET /api/me with credentials included', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ user: { id: 1, displayName: 'Someone' } }) });

    const result = await fetchMe();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/me');
    expect(init.credentials).toBe('include');
    expect(result).toEqual({ user: { id: 1, displayName: 'Someone' } });
  });

  it('logout calls POST /api/auth/logout with credentials included', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await logout();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('preserves caller-supplied options (method/headers/body) alongside credentials', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ event: {} }) });

    await resolveEvent('fireslam23test');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ input: 'fireslam23test' });
    expect(init.credentials).toBe('include');
  });

  it('throws the server-provided error message on a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: 'Not signed in' }) });

    await expect(fetchMe()).rejects.toThrow('Not signed in');
  });

  it('falls back to a generic message when the error body has none', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    await expect(fetchMe()).rejects.toThrow('Request failed (500)');
  });
});
