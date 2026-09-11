import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gql, gqlWithCost, parseStartggInput, resolveShortUrl, StartggComplexityError, StartggError } from './startgg.js';

// start.gg's own responses, verbatim from live traffic where possible. The
// self-healing pager reads specific things out of these, so a change in shape
// would silently disable the recovery it depends on.
describe('gqlWithCost', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function respond(status: number, body: unknown, ok = status >= 200 && status < 300) {
    fetchMock.mockResolvedValue({ ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  }

  it('returns the data and the complexity start.gg reports', async () => {
    respond(200, { data: { thing: 1 }, extensions: { queryComplexity: 696 } });

    const result = await gqlWithCost<{ thing: number }>('token', 'query {}', {});

    expect(result.data).toEqual({ thing: 1 });
    // The pager sizes later pages from this, so losing it costs the cost model.
    expect(result.complexity).toBe(696);
  });

  it('reports null complexity rather than failing when extensions are absent', async () => {
    respond(200, { data: { thing: 1 } });

    expect((await gqlWithCost('token', 'query {}', {})).complexity).toBeNull();
  });

  it('turns a complexity rejection into a typed error carrying the object count', async () => {
    // Exactly what start.gg returned for a 50-set bracket page.
    respond(200, {
      errors: [
        { message: 'Your query complexity is too high. A maximum of 1000 objects may be returned by each request. (actual: 1053)' },
      ],
    });

    const err = await gql('token', 'query {}', {}).catch((e) => e);

    expect(err).toBeInstanceOf(StartggComplexityError);
    // Without this number the pager cannot compute a smaller page size.
    expect((err as StartggComplexityError).actual).toBe(1053);
  });

  it('falls back to a plain error when a complexity message carries no count', async () => {
    respond(200, { errors: [{ message: 'Your query complexity is too high.' }] });

    const err = await gql('token', 'query {}', {}).catch((e) => e);

    expect(err).toBeInstanceOf(StartggError);
    expect(err).not.toBeInstanceOf(StartggComplexityError);
  });

  it('does not mistake an ordinary GraphQL error for a complexity rejection', async () => {
    respond(200, { errors: [{ message: 'Not authorized' }] });

    const err = await gql('token', 'query {}', {}).catch((e) => e);

    expect(err).not.toBeInstanceOf(StartggComplexityError);
    expect((err as Error).message).toMatch(/Not authorized/);
  });

  it('explains a rate limit instead of surfacing a parse failure', async () => {
    // 429s come back as JSON but are handled on status, before any parsing.
    respond(429, { success: false, message: 'Rate limit exceeded - api-token' }, false);

    const err = await gql('token', 'query {}', {}).catch((e) => e);

    expect((err as Error).message).toMatch(/rate limiting/i);
    expect((err as StartggError).status).toBe(429);
  });

  it('survives a non-JSON body rather than throwing a parser error', async () => {
    respond(502, '<html><body>Bad Gateway</body></html>', false);

    const err = await gql('token', 'query {}', {}).catch((e) => e);

    expect((err as Error).message).toMatch(/502/);
    expect((err as Error).message).not.toMatch(/JSON/i);
  });

  it('treats a 200 that is not JSON as unreadable, not as data', async () => {
    respond(200, 'not json at all');

    await expect(gql('token', 'query {}', {})).rejects.toThrow(/could not read/i);
  });

  it('reports a timeout in terms a caller can act on', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    await expect(gql('token', 'query {}', {})).rejects.toThrow(/did not respond in time/i);
  });

  it('reports an unreachable host separately from a timeout', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(gql('token', 'query {}', {})).rejects.toThrow(/could not reach/i);
  });

  it('sends the caller’s token and an abort signal', async () => {
    respond(200, { data: {} });

    await gql('a-token', 'query Q {}', { x: 1 });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer a-token');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ query: 'query Q {}', variables: { x: 1 } });
  });
});

describe('parseStartggInput', () => {
  it('marks a bare slug as bare and an explicit tournament path as not', () => {
    // The whole point of the flag: these two strings resolve to different
    // tournaments, so only the first may be treated as a short URL.
    expect(parseStartggInput('supernova')).toEqual({ type: 'tournament', slug: 'supernova', bare: true });
    expect(parseStartggInput('start.gg/tournament/supernova')).toEqual({
      type: 'tournament',
      slug: 'supernova',
      bare: false,
    });
  });

  it('strips scheme, host, trailing slash and query before deciding', () => {
    expect(parseStartggInput('  https://www.start.gg/uva/?foo=1  ')).toEqual({
      type: 'tournament',
      slug: 'uva',
      bare: true,
    });
  });

  it('keeps a full event slug intact', () => {
    expect(parseStartggInput('https://start.gg/tournament/supernova-2026/event/ultimate-singles')).toEqual({
      type: 'event',
      slug: 'tournament/supernova-2026/event/ultimate-singles',
    });
  });
});

describe('resolveShortUrl', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('returns the canonical slug the short URL redirects to', async () => {
    // The live collision this exists for: start.gg/supernova serves Supernova
    // 2026, while tournament(slug:"supernova") returns SuperNova 2016.
    fetchMock.mockResolvedValue({ ok: true, url: 'https://www.start.gg/tournament/supernova-2026/events' });

    expect(await resolveShortUrl('supernova')).toBe('supernova-2026');
  });

  it('returns null when start.gg does not know the slug', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, url: 'https://www.start.gg/nope' });

    expect(await resolveShortUrl('nope')).toBeNull();
  });

  it('returns null rather than throwing when start.gg is unreachable', async () => {
    // The degrade that keeps a site blip from failing an event load — the
    // caller falls back to resolving through the API.
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

    expect(await resolveShortUrl('supernova')).toBeNull();
  });

  it('returns null when the short URL lands somewhere that is not a tournament', async () => {
    fetchMock.mockResolvedValue({ ok: true, url: 'https://www.start.gg/user/abc123' });

    expect(await resolveShortUrl('abc123')).toBeNull();
  });

  it('refuses a slug that could not be a short URL, without making a request', async () => {
    // The slug is interpolated into a URL path, so anything able to change the
    // path's shape is rejected outright instead of escaped.
    for (const bad of ['../../admin', 'a/b', 'a?b', 'http://evil.test', '']) {
      expect(await resolveShortUrl(bad)).toBeNull();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
