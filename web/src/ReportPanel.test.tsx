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

/** Grand Final is the one round guessRequiredWins reads as best-of-five. */
function renderPanel(fullRoundText: string) {
  render(
    <ReportPanel
      set={setFor(fullRoundText)}
      presumedWinnerId={10}
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
 * start.gg will not change a finished set's winner in place — the result has
 * to be torn down first, and tearing it down takes everything downstream with
 * it (verified live). The panel cannot work out on its own whether that is
 * what a report means: a losers-bracket set is reached through a bye set that
 * start.gg leaves out of the bracket the app fetches. So the server refuses,
 * says what it would clear, and this is where that refusal is answered.
 */
describe('ReportPanel — clearing a decided set to change who won', () => {
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
  });

  it('names what the teardown clears, using the list only the server can build', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I', 'R']));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    expect(warning()).toContain('I, R');
  });

  it('says it could not check, rather than implying nothing else is affected', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(null));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    expect(warning()).toMatch(/couldn't check/i);
  });

  it('does not report anything until the teardown is confirmed', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    expect(vi.mocked(reportSet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportSet).mock.calls[0][0].confirmReset).toBeFalsy();
  });

  it('confirms the teardown only on a second, deliberate Enter', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'Enter' });

    await vi.waitFor(() => expect(vi.mocked(reportSet)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(reportSet).mock.calls[1][0].confirmReset).toBe(true);
  });

  it('backs out on Escape without clearing anything', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(warning()).toBeNull();
    expect(vi.mocked(reportSet)).toHaveBeenCalledTimes(1);
  });

  it('confirms the teardown on a click, too — not only from the keyboard', async () => {
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    const yes = [...document.querySelectorAll('button')].find((b) => /clear the old result/i.test(b.getAttribute('aria-label') ?? ''));
    fireEvent.click(yes!);

    await vi.waitFor(() => expect(vi.mocked(reportSet)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(reportSet).mock.calls[1][0].confirmReset).toBe(true);
  });

  it('takes any other key as backing out, never as agreement', async () => {
    // A confirmation that fires on whatever key the TO happened to hit next is
    // not a confirmation, and this one clears results.
    vi.mocked(reportSet).mockRejectedValueOnce(refusal(['I']));
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(warning()).not.toBeNull());
    fireEvent.keyDown(window, { key: 'w' });

    expect(warning()).toBeNull();
    expect(vi.mocked(reportSet)).toHaveBeenCalledTimes(1);
  });

  it('never asks for a teardown on an ordinary report', async () => {
    renderPanel('Winners Round 1');
    submit();

    await vi.waitFor(() => expect(vi.mocked(reportSet)).toHaveBeenCalled());
    expect(vi.mocked(reportSet).mock.calls[0][0].confirmReset).toBeFalsy();
    expect(warning()).toBeNull();
  });

  it('never asks for a teardown when the ordinary confirm is clicked either', async () => {
    // submit's first parameter is confirmReset, so handing this button
    // straight to onClick passes it a MouseEvent — truthy — and every mouse
    // report becomes a teardown request. Caught once by tsc; pinned here.
    renderPanel('Winners Round 1');
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });
    const yes = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Confirm report');
    fireEvent.click(yes!);

    await vi.waitFor(() => expect(vi.mocked(reportSet)).toHaveBeenCalled());
    expect(vi.mocked(reportSet).mock.calls[0][0].confirmReset).toBeFalsy();
  });
});
