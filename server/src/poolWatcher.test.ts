import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gqlMock = vi.fn();
vi.mock('./startgg.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./startgg.js')>()),
  gql: (...args: unknown[]) => gqlMock(...args),
}));

const getUserByIdMock = vi.fn();
vi.mock('./db/users.js', () => ({ getUserById: (id: number) => getUserByIdMock(id) }));

const { startWatching, stopWatching, isWatching, stopAllWatching, PULSE } = await import('./poolWatcher.js');
const { subscribe, publishPoolChanged, resetPoolEvents } = await import('./poolEvents.js');

/** One page of the detector's scalars-only query. */
function pulse(sets: { id: number; state: number; winnerId?: number | null; displayScore?: string | null }[]) {
  return {
    phaseGroup: {
      sets: {
        pageInfo: { totalPages: 1 },
        nodes: sets.map((s) => ({ id: s.id, state: s.state, winnerId: s.winnerId ?? null, displayScore: s.displayScore ?? null })),
      },
    },
  };
}

function watcher(phaseGroupId: string, userId = 1) {
  const received: string[] = [];
  subscribe(phaseGroupId, { userId, send: (e) => (received.push(e), true) });
  return received;
}

/** Let the detector's in-flight promises settle between ticks. */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('the pool change detector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gqlMock.mockReset();
    getUserByIdMock.mockReset();
    getUserByIdMock.mockResolvedValue({ id: 1, accessToken: 'token-1' });
  });

  afterEach(() => {
    stopAllWatching();
    resetPoolEvents();
    vi.useRealTimers();
  });

  it('says nothing on the first look, having nothing to compare against', async () => {
    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 1 }]));
    const heard = watcher('7');

    startWatching('7');
    await settle();

    // Otherwise every TO refetches the moment anyone opens a pool.
    expect(heard).toEqual([]);
  });

  it('tells watchers once a set actually moves', async () => {
    gqlMock.mockResolvedValueOnce(pulse([{ id: 1, state: 1 }]));
    const heard = watcher('7');
    startWatching('7');
    await settle();

    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 3, winnerId: 8001, displayScore: 'A 2 - B 0' }]));
    await vi.advanceTimersByTimeAsync(4000);
    await settle();

    expect(heard).toEqual(['changed']);
  });

  it('stays quiet while the pool is unchanged', async () => {
    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 1 }]));
    const heard = watcher('7');
    startWatching('7');
    await settle();

    // The case that makes this worth doing: most ticks find nothing, and cost
    // one request for the pool rather than one per TO.
    await vi.advanceTimersByTimeAsync(20000);
    await settle();

    expect(heard).toEqual([]);
  });

  it('is not fooled by start.gg returning the same sets in a different order', async () => {
    gqlMock.mockResolvedValueOnce(pulse([{ id: 1, state: 1 }, { id: 2, state: 1 }]));
    const heard = watcher('7');
    startWatching('7');
    await settle();

    gqlMock.mockResolvedValue(pulse([{ id: 2, state: 1 }, { id: 1, state: 1 }]));
    await vi.advanceTimersByTimeAsync(4000);
    await settle();

    expect(heard).toEqual([]);
  });

  it('rotates across the TOs watching, rather than spending one of them', async () => {
    getUserByIdMock.mockImplementation((id: number) => Promise.resolve({ id, accessToken: `token-${id}` }));
    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 1 }]));
    watcher('7', 1);
    watcher('7', 2);

    startWatching('7');
    await settle();
    await vi.advanceTimersByTimeAsync(4000);
    await settle();

    // The cost falls on the people benefiting from it, not on whoever opened
    // the pool first.
    const used = gqlMock.mock.calls.map((c) => c[0]);
    expect(new Set(used)).toEqual(new Set(['token-1', 'token-2']));
  });

  it('says nothing when a probe fails', async () => {
    gqlMock.mockResolvedValueOnce(pulse([{ id: 1, state: 1 }]));
    const heard = watcher('7');
    startWatching('7');
    await settle();

    // Announcing a change that may not have happened makes every watcher
    // refetch for nothing; the clients' own safety-net poll still covers them.
    gqlMock.mockRejectedValue(new Error('start.gg is down'));
    await vi.advanceTimersByTimeAsync(8000);
    await settle();

    expect(heard).toEqual([]);
  });

  it('does not probe a pool nobody is watching', async () => {
    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 1 }]));

    startWatching('7'); // no subscribers
    await settle();
    await vi.advanceTimersByTimeAsync(8000);
    await settle();

    expect(gqlMock).not.toHaveBeenCalled();
  });

  it('stops entirely once the last watcher leaves', async () => {
    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 1 }]));
    watcher('7');
    startWatching('7');
    await settle();
    const afterStart = gqlMock.mock.calls.length;

    stopWatching('7');
    await vi.advanceTimersByTimeAsync(20000);
    await settle();

    expect(isWatching('7')).toBe(false);
    expect(gqlMock.mock.calls.length).toBe(afterStart);
  });

  it('keeps one detector per pool however many times it is started', async () => {
    gqlMock.mockResolvedValue(pulse([{ id: 1, state: 1 }]));
    watcher('7', 1);
    watcher('7', 2);

    startWatching('7');
    startWatching('7');
    await settle();
    const afterStarts = gqlMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(4000);
    await settle();

    // Two TOs opening the same pool must not double the requests, which is the
    // entire point of detecting centrally.
    expect(gqlMock.mock.calls.length - afterStarts).toBe(1);
  });

  it('pages a pool too big for one request', async () => {
    // The cost model says ~900 sets fit in one request; a bracket past that
    // must still be fingerprinted completely or changes in it go unnoticed.
    gqlMock.mockImplementation((_t: unknown, _q: string, vars: { page: number }) =>
      Promise.resolve({
        phaseGroup: {
          sets: { pageInfo: { totalPages: 2 }, nodes: [{ id: vars.page, state: 1, winnerId: null, displayScore: null }] },
        },
      })
    );
    watcher('7');
    startWatching('7');
    await settle();

    expect(gqlMock.mock.calls.map((c) => c[2].page)).toEqual([1, 2]);
    expect(PULSE.perPage).toBeGreaterThan(400);
  });
});

// Keeps the detector from publishing through a channel that has moved on.
describe('publishing', () => {
  it('reaches only the pool that changed', () => {
    const seven = watcher('7');
    const eight = watcher('8');
    publishPoolChanged('7');
    expect(seven).toEqual(['changed']);
    expect(eight).toEqual([]);
    resetPoolEvents();
  });
});
