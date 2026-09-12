import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ReportPanel } from './ReportPanel';
import { ApiError, reportSet } from './api';
import type { OpenSet } from './types';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  reportSet: vi.fn().mockResolvedValue({ result: {} }),
  updatePlayerMain: vi.fn().mockResolvedValue({ characterId: null }),
}));

function setFor(fullRoundText: string): OpenSet {
  return {
    id: 1,
    isPreview: false,
    isStarted: false,
    fullRoundText,
    identifier: 'A',
    lPlacement: null,
    entrants: [
      { id: 10, name: 'Ada', playerId: 11 },
      { id: 20, name: 'mudd', playerId: 12 },
    ],
  };
}

const onQueue = vi.fn();

/** Grand Final is the one round guessRequiredWins reads as best-of-five. */
function renderPanel(fullRoundText: string, priorWinnerEntrantId: number | null = null) {
  render(
    <ReportPanel
      set={setFor(fullRoundText)}
      presumedWinnerId={10}
      priorWinnerEntrantId={priorWinnerEntrantId}
      onQueue={onQueue}
      characters={[]}
      stages={[]}
      topXBo5={null}
      videogameId={1386}
      phaseGroupId={1}
      onNotify={vi.fn()}
      onAuthError={() => false}
      onDone={vi.fn()}
      onCancel={vi.fn()}
    />
  );
}

const type = (keys: string) => {
  for (const key of keys) fireEvent.keyDown(window, { key });
};
const hint = () => document.querySelector('.score-shortfall')?.textContent ?? null;
const scoreLine = () => document.querySelector('.score-line')?.textContent?.replace(/\s+/g, ' ').trim();
const reportDisabled = () =>
  [...document.querySelectorAll('button')].find((b) => /report set/i.test(b.textContent ?? ''))?.hasAttribute('disabled');

describe('ReportPanel — why the report button is disabled', () => {
  it('says what a best-of-five score is still short of', () => {
    // The realistic way a TO lands here: the round guess picked Bo5 for a set
    // that was actually Bo3, so their 2-0 is right and the format is wrong.
    renderPanel('Grand Final');
    type('ww');

    expect(scoreLine()).toBe('Ada 2–0 mudd');
    expect(hint()).toBe('2 of 3 wins — Bo5 (press b to change)');
    // The hint exists because this state is unreachable otherwise: the error
    // is suppressed while the preview has something to draw.
    expect(document.querySelector('.report-panel .error')).toBeNull();
    expect(reportDisabled()).toBe(true);
  });

  it('drops the hint as soon as the score is complete', () => {
    renderPanel('Grand Final');
    type('www');

    expect(scoreLine()).toBe('Ada 3–0 mudd');
    expect(hint()).toBeNull();
    expect(reportDisabled()).toBe(false);
  });

  it('says nothing for the same two wins at best-of-three, where they finish the set', () => {
    // Identical keystrokes, different format: here 2-0 is a complete score and
    // a hint would be noise.
    renderPanel('Winners Round 1');
    type('ww');

    expect(scoreLine()).toBe('Ada 2–0 mudd');
    expect(hint()).toBeNull();
    expect(reportDisabled()).toBe(false);
  });

  it('counts only the winner’s games, not the total played', () => {
    renderPanel('Grand Final');
    type('wlw');

    expect(scoreLine()).toBe('Ada 2–1 mudd');
    expect(hint()).toBe('2 of 3 wins — Bo5 (press b to change)');
  });

  it('updates as the set fills in', () => {
    renderPanel('Grand Final');
    type('w');
    expect(hint()).toBe('1 of 3 wins — Bo5 (press b to change)');
    type('w');
    expect(hint()).toBe('2 of 3 wins — Bo5 (press b to change)');
    type('w');
    expect(hint()).toBeNull();
  });

  it('shows nothing before anything is typed', () => {
    renderPanel('Grand Final');
    expect(hint()).toBeNull();
  });
});

/**
 * A report is handed to the outbox and the panel closes — the TO is already at
 * the next table. The one exception is changing who won a decided set: start.gg
 * can only do that by tearing the result down and taking everything downstream
 * with it, and what that clears is only knowable server-side. So that one is
 * asked about before it is queued.
 */
describe('ReportPanel — handing a report to the outbox', () => {
  const warning = () => document.querySelector('.reset-warning')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
  const submit = () => {
    for (const key of ['w', 'w', 'Enter', 'Enter']) fireEvent.keyDown(window, { key });
  };
  const refusal = (wouldClear: unknown) =>
    new ApiError('Changing who won means clearing this result and everything it fed into.', 409, {
      requiresReset: true,
      wouldClear,
    });

  afterEach(() => {
    vi.mocked(reportSet).mockReset();
    vi.mocked(reportSet).mockResolvedValue({ result: {} });
    onQueue.mockReset();
  });

  it('queues an ordinary report instead of waiting on start.gg', () => {
    renderPanel('Winners Round 1');
    submit();

    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onQueue.mock.calls[0][0]).toMatchObject({ setId: 1, winnerEntrantId: 10, shorthand: 'WW' });
    // Nothing was sent from here: the panel does not wait for a round trip.
    expect(vi.mocked(reportSet)).not.toHaveBeenCalled();
  });

  it('labels the report with both names, so it is recognisable minutes later', () => {
    renderPanel('Winners Round 1');
    submit();

    expect(onQueue.mock.calls[0][1]).toBe('Ada vs mudd');
  });

  it('queues a score correction too — editing a score in place is not destructive', () => {
    // Same winner on file as the one being reported, so nothing is torn down.
    renderPanel('Winners Round 1', 10);
    submit();

    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportSet)).not.toHaveBeenCalled();
  });

  it('never queues a report that changes the winner without asking first', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I', 'R']));
    renderPanel('Winners Round 1', 20);
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('names what the teardown clears, using the list only the server can build', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I', 'R']));
    renderPanel('Winners Round 1', 20);
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    expect(warning()).toContain('I, R');
  });

  it('says it could not check, rather than implying nothing else is affected', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(null));
    renderPanel('Winners Round 1', 20);
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    expect(warning()).toMatch(/couldn't check/i);
  });

  it('queues the teardown once the TO agrees, carrying their agreement with it', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1', 20);
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onQueue.mock.calls[0][0].confirmReset).toBe(true);
  });

  it('backs out on Escape without queueing anything', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1', 20);
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(warning()).toBeNull();
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('takes any other key as backing out, never as agreement', async () => {
    // A confirmation that fires on whatever key the TO hits next is not a
    // confirmation, and this one clears results.
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1', 20);
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'w' });

    expect(warning()).toBeNull();
    expect(onQueue).not.toHaveBeenCalled();
  });

  it('never sets confirmReset on an ordinary report, even clicked rather than typed', async () => {
    // submit's first parameter is confirmReset, so handing this button to
    // onClick passes it a MouseEvent — truthy — and every mouse report becomes
    // a teardown request. Caught once by tsc; pinned here.
    renderPanel('Winners Round 1');
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });
    const yes = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Confirm report');
    fireEvent.click(yes!);

    await vi.waitFor(() => expect(onQueue).toHaveBeenCalled());
    expect(onQueue.mock.calls[0][0].confirmReset).toBeFalsy();
  });
});

/**
 * Reporting an unfinished score is already refused, but Enter still opened the
 * confirmation and the second Enter silently did nothing — so the screen said
 * "confirm?" about something it had already decided it would not accept.
 */
describe('ReportPanel — Enter on a score that cannot be reported', () => {
  const confirmRow = () => document.querySelector('.submit-confirm');
  const nudge = () => document.querySelector('.score-display.nudge');
  const blocked = () => document.querySelector('.score-blocked')?.textContent ?? null;

  it('does not offer to confirm a score that is still unfinished', () => {
    renderPanel('Grand Final'); // best of five
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });

    expect(confirmRow()).toBeNull();
  });

  it('points at what is missing instead of doing nothing visible', () => {
    renderPanel('Grand Final');
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });

    expect(nudge()).not.toBeNull();
    expect(document.querySelector('.score-shortfall')?.textContent).toContain('2 of 3 wins');
  });

  it('says to type a score when nothing has been entered at all', () => {
    // Nothing typed means no shortfall line to point at, so the nudge needs
    // something of its own to say.
    renderPanel('Winners Round 1');
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(blocked()).toMatch(/type a score/i);
    expect(confirmRow()).toBeNull();
  });

  it('still confirms a score that is actually complete', () => {
    renderPanel('Winners Round 1'); // best of three
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });

    expect(confirmRow()).not.toBeNull();
    expect(nudge()).toBeNull();
  });

  it('clears the nudge once the score is finished', () => {
    renderPanel('Grand Final');
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });
    expect(nudge()).not.toBeNull();

    fireEvent.keyDown(window, { key: 'w' });

    expect(nudge()).toBeNull();
  });
});
