import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushClientEvents, installCrashReporting, recordClientEvent, resetClientEvents } from './clientEvents';

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): { sessionId: string; events: Record<string, unknown>[] }[] {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
}

describe('client event beacon', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetClientEvents();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('batches a burst of events into one request', async () => {
    // Venue wifi failing takes the whole queue down at once. One request per
    // event would put the beacon in competition with the reports it observes.
    recordClientEvent('report-failed', { setId: '1', attempt: 1 });
    recordClientEvent('report-failed', { setId: '2', attempt: 1 });
    recordClientEvent('report-failed', { setId: '3', attempt: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [body] = sentBodies(fetchMock);
    expect(body.events).toHaveLength(3);
    expect(body.events.map((e) => e.setId)).toEqual(['1', '2', '3']);
    expect(body.sessionId).toMatch(/^[a-z0-9]+$/);
  });

  it('drops null and undefined fields rather than sending them', async () => {
    recordClientEvent('report-failed', { setId: '1', status: null, message: undefined, attempt: 2 });
    await vi.advanceTimersByTimeAsync(2_000);

    const [body] = sentBodies(fetchMock);
    expect(body.events[0]).toEqual({ kind: 'report-failed', setId: '1', attempt: 2 });
  });

  it('sends immediately once a batch reaches its size cap', async () => {
    for (let i = 0; i < 20; i++) recordClientEvent('crash', { n: i });

    // No timer advance: the twentieth event flushes on its own.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBodies(fetchMock)[0].events).toHaveLength(20);
  });

  it('stops recording after a page load spends its budget', async () => {
    // A render loop throwing every frame must not spend a TO's connection on
    // telemetry about itself.
    for (let i = 0; i < 260; i++) recordClientEvent('crash', { n: i });
    await vi.advanceTimersByTimeAsync(2_000);

    const total = sentBodies(fetchMock).reduce((sum, body) => sum + body.events.length, 0);
    expect(total).toBe(200);
  });

  it('does not throw or cascade when the beacon request itself fails', async () => {
    // The dangerous case: a rejection here reaches the global handler, which
    // would record it as another event, which would fail the same way.
    //
    // The .catch() in flushClientEvents is what prevents that, and removing it
    // does not fail an assertion here — it fails the run through vitest's
    // unhandled-rejection reporting (verified by deleting it). Do not "tidy"
    // that catch away on the strength of these assertions alone.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    installCrashReporting();

    recordClientEvent('report-failed', { setId: '1' });
    expect(() => flushClientEvents()).not.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not throw when fetch fails synchronously', () => {
    fetchMock.mockImplementation(() => {
      throw new TypeError('offline');
    });

    recordClientEvent('crash', {});
    expect(() => flushClientEvents()).not.toThrow();
  });

  it('keeps working after a failed flush', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    recordClientEvent('crash', { n: 1 });
    await vi.advanceTimersByTimeAsync(2_000);

    recordClientEvent('crash', { n: 2 });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBodies(fetchMock)[1].events[0].n).toBe(2);
  });

  it('flushes what is buffered when the phone goes in a pocket', async () => {
    installCrashReporting();
    recordClientEvent('report-failed', { setId: '7' });

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBodies(fetchMock)[0].events[0].setId).toBe('7');
  });

  it('reports an uncaught error the app never handled', async () => {
    installCrashReporting();

    window.dispatchEvent(new ErrorEvent('error', { message: 'x is not a function', filename: 'app.js', lineno: 42 }));
    await vi.advanceTimersByTimeAsync(2_000);

    const [body] = sentBodies(fetchMock);
    expect(body.events[0]).toMatchObject({
      kind: 'crash',
      message: 'x is not a function',
      source: 'app.js',
      line: 42,
    });
  });

  it('reports a rejected promise the app never handled', async () => {
    installCrashReporting();

    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = new Error('bracket load blew up');
    window.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(2_000);

    const [body] = sentBodies(fetchMock);
    expect(body.events[0]).toMatchObject({ kind: 'unhandled-rejection', message: 'bracket load blew up' });
  });
});
