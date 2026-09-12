import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allEntries, backoffFor, clearOutbox, drainOnce, enqueue, remove, resetOutbox, retryNow, update } from './outbox';
import type { DeliverResult } from './outbox';
import type { ReportPayload } from './api';

function payload(setId: number | string = 1): ReportPayload {
  return { setId, winnerEntrantId: 10, loserEntrantId: 20, requiredWins: 2, shorthand: '+' };
}

const delivered: string[] = [];
function deps(send: (p: ReportPayload, attempt: number) => Promise<DeliverResult>, now = 1000) {
  return { now, random: () => 0, send, onDelivered: (e: { label: string }) => void delivered.push(e.label) };
}

const ok = async (): Promise<DeliverResult> => ({ ok: true });

beforeEach(() => {
  localStorage.clear();
  resetOutbox();
  delivered.length = 0;
});

afterEach(() => {
  localStorage.clear();
  resetOutbox();
});

describe('the outbox as a record of what has not landed yet', () => {
  it('holds a report the instant it is submitted', () => {
    enqueue(payload(), 'Ada vs mudd', 1000);

    expect(allEntries()).toHaveLength(1);
    expect(allEntries()[0].state).toBe('sending');
  });

  it('survives the tab being closed and reopened', () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    resetOutbox(); // a fresh page load, same browser storage

    expect(allEntries().map((e) => e.label)).toEqual(['Ada vs mudd']);
  });

  it('keeps one report per set, so re-reporting replaces rather than races', () => {
    enqueue({ ...payload(), shorthand: '+' }, 'Ada vs mudd', 1000);
    enqueue({ ...payload(), shorthand: 'WLW' }, 'Ada vs mudd', 2000);

    expect(allEntries()).toHaveLength(1);
    expect(allEntries()[0].payload.shorthand).toBe('WLW');
  });

  it('keeps reports for different sets apart', () => {
    enqueue(payload(1), 'Ada vs mudd', 1000);
    enqueue(payload(2), 'Bo vs Cy', 2000);

    expect(allEntries()).toHaveLength(2);
  });

  it('ignores a stored entry that is not a report', () => {
    // Anything in here gets sent to start.gg as a result, so a half-written or
    // hand-edited key must be dropped rather than delivered on a guess.
    localStorage.setItem('smashset.outbox.99', JSON.stringify({ setId: '99' }));
    localStorage.setItem('smashset.outbox.98', 'not json at all');
    resetOutbox();

    expect(allEntries()).toEqual([]);
  });

  it('lets a TO who signs out leave nothing behind for the next one', () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    clearOutbox();
    resetOutbox();

    expect(allEntries()).toEqual([]);
  });

  it('works without localStorage, it just stops surviving a reload', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    try {
      enqueue(payload(), 'Ada vs mudd', 1000);
      expect(allEntries()).toHaveLength(1);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('delivering what is queued', () => {
  it('drops an entry start.gg confirmed, and says so only then', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);

    await drainOnce(deps(ok));

    expect(allEntries()).toEqual([]);
    expect(delivered).toEqual(['Ada vs mudd']);
  });

  it('counts the attempt, so the server can hold a retry to a stricter rule', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    const attempts: number[] = [];
    const send = async (_p: ReportPayload, attempt: number): Promise<DeliverResult> => {
      attempts.push(attempt);
      return { ok: false, retryable: true, message: 'offline' };
    };

    await drainOnce(deps(send, 1000));
    await drainOnce(deps(send, 100_000));

    expect(attempts).toEqual([1, 2]);
  });

  it('waits longer after each failure, and never gives up on a retryable one', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    const send = async (): Promise<DeliverResult> => ({ ok: false, retryable: true, message: 'offline' });

    let now = 1000;
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await drainOnce(deps(send, now));
      const entry = allEntries()[0];
      waits.push(entry.nextAttemptAt - now);
      now = entry.nextAttemptAt;
    }

    expect(waits).toEqual([500, 1000, 2000, 4000]); // random() === 0, so the low end of the jitter
    expect(allEntries()[0].state).toBe('sending');
  });

  it('does not deliver before the backoff has elapsed', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    const send = vi.fn(async (): Promise<DeliverResult> => ({ ok: false, retryable: true }));
    await drainOnce(deps(send, 1000));
    expect(send).toHaveBeenCalledTimes(1);

    await drainOnce(deps(send, 1100)); // still inside the wait

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('gives up on a refusal start.gg will never change its mind about', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    const send = async (): Promise<DeliverResult> => ({ ok: false, retryable: false, message: 'This set is between different players now.' });

    await drainOnce(deps(send));

    const entry = allEntries()[0];
    expect(entry.state).toBe('failed');
    expect(entry.error).toBe('This set is between different players now.');
    expect(delivered).toEqual([]);
  });

  it('leaves a dead-lettered report alone until the TO asks again', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    const send = vi.fn(async (): Promise<DeliverResult> => ({ ok: false, retryable: false }));
    await drainOnce(deps(send, 1000));

    await drainOnce(deps(send, 999_999));

    expect(send).toHaveBeenCalledTimes(1);
    expect(allEntries()[0].state).toBe('failed');
  });

  it('sends a dead-lettered report again when the TO does ask', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    const failing = async (): Promise<DeliverResult> => ({ ok: false, retryable: false });
    await drainOnce(deps(failing, 1000));

    retryNow('1', 5000);
    await drainOnce(deps(ok, 5000));

    expect(allEntries()).toEqual([]);
    expect(delivered).toEqual(['Ada vs mudd']);
  });

  it('delivers one at a time, in the order they were reported', async () => {
    enqueue(payload(1), 'first', 1000);
    enqueue(payload(2), 'second', 1001);
    const inFlight: string[] = [];
    const send = async (p: ReportPayload): Promise<DeliverResult> => {
      inFlight.push(String(p.setId));
      return { ok: true };
    };

    await drainOnce(deps(send, 2000));
    await drainOnce(deps(send, 2000));

    expect(inFlight).toEqual(['1', '2']);
  });

  it('does not start a second delivery while one is still in the air', async () => {
    enqueue(payload(1), 'first', 1000);
    enqueue(payload(2), 'second', 1001);
    let release: (r: DeliverResult) => void = () => {};
    const send = vi.fn(() => new Promise<DeliverResult>((resolve) => (release = resolve)));

    const first = drainOnce(deps(send));
    await drainOnce(deps(send)); // fires while the first is still pending

    expect(send).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await first;
  });

  it('does nothing at all when there is nothing queued', async () => {
    const send = vi.fn(ok);

    expect(await drainOnce(deps(send))).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the report when delivery fails, rather than losing the score', async () => {
    enqueue(payload(), 'Ada vs mudd', 1000);

    await drainOnce(deps(async () => ({ ok: false, retryable: true, message: 'Could not reach the server.' })));

    expect(allEntries()).toHaveLength(1);
    expect(allEntries()[0].payload.shorthand).toBe('+');
  });
});

describe('backoff', () => {
  it('grows with each attempt', () => {
    expect(backoffFor(1, 0)).toBeLessThan(backoffFor(2, 0));
    expect(backoffFor(2, 0)).toBeLessThan(backoffFor(3, 0));
  });

  it('stops growing, so a long outage still retries about twice a minute', () => {
    expect(backoffFor(20, 1)).toBe(30_000);
  });

  it('spreads retries out, because every TO at a venue shares one access point', () => {
    expect(backoffFor(5, 0)).not.toBe(backoffFor(5, 1));
  });
});

describe('housekeeping', () => {
  it('forgets an entry that has been removed, across a reload', () => {
    enqueue(payload(), 'Ada vs mudd', 1000);
    remove('1');
    resetOutbox();

    expect(allEntries()).toEqual([]);
  });

  it('ignores an update for a report that is already gone', () => {
    update('nope', { state: 'failed' });
    expect(allEntries()).toEqual([]);
  });
});
