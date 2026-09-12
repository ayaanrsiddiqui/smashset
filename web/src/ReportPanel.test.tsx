import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ReportPanel } from './ReportPanel';
import { reportSet } from './api';
import type { OpenSet } from './types';

vi.mock('./api', () => ({
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

interface Extra {
  priorWinnerEntrantId?: number | null;
  resetCascade?: string[];
  advancesToPhases?: string[];
}

/** Grand Final is the one round guessRequiredWins reads as best-of-five. */
function renderPanel(fullRoundText: string, extra: Extra = {}) {
  render(
    <ReportPanel
      set={setFor(fullRoundText)}
      presumedWinnerId={10}
      priorWinnerEntrantId={extra.priorWinnerEntrantId ?? null}
      resetCascade={extra.resetCascade ?? []}
      advancesToPhases={extra.advancesToPhases ?? []}
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
 * it (verified live). So this is the one thing a TO can do from a phone that
 * destroys work, and it must never happen on a mis-tap.
 */
describe('ReportPanel — changing who won a set that is already decided', () => {
  const confirm = () => {
    for (const key of ['w', 'w', 'Enter']) fireEvent.keyDown(window, { key });
  };
  const warning = () => document.querySelector('.reset-warning')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;

  afterEach(() => {
    vi.mocked(reportSet).mockClear();
  });

  it('names the already-played sets it will wipe', () => {
    renderPanel('Winners Round 1', { priorWinnerEntrantId: 20, resetCascade: ['I', 'M'] });
    confirm();

    expect(warning()).toContain('I, M');
  });

  it('still warns when nothing downstream has been played, because the result itself goes', () => {
    renderPanel('Winners Round 1', { priorWinnerEntrantId: 20, resetCascade: [] });
    confirm();

    expect(warning()).toMatch(/clear/i);
  });

  it('says where else this set reaches, which the pool view cannot show', () => {
    renderPanel('Winners Round 1', { priorWinnerEntrantId: 20, resetCascade: [], advancesToPhases: ['Top 8'] });
    confirm();

    expect(warning()).toContain('Top 8');
  });

  it('says nothing when the winner on file is the one being reported', () => {
    // Correcting only the score. start.gg edits that in place, so nothing is
    // torn down and a warning here would just train the TO to ignore it.
    renderPanel('Winners Round 1', { priorWinnerEntrantId: 10, resetCascade: ['I', 'M'] });
    confirm();

    expect(warning()).toBeNull();
  });

  it('says nothing for a set nobody has reported yet', () => {
    renderPanel('Winners Round 1', { resetCascade: ['I', 'M'] });
    confirm();

    expect(warning()).toBeNull();
  });

  it('only asks the server to tear anything down once the TO has confirmed it', async () => {
    renderPanel('Winners Round 1', { priorWinnerEntrantId: 20, resetCascade: ['I'] });
    confirm();
    fireEvent.keyDown(window, { key: 'Enter' });

    await vi.waitFor(() => expect(vi.mocked(reportSet)).toHaveBeenCalled());
    expect(vi.mocked(reportSet).mock.calls[0][0].confirmReset).toBe(true);
  });

  it('never sends confirmReset for an ordinary report', async () => {
    renderPanel('Winners Round 1');
    confirm();
    fireEvent.keyDown(window, { key: 'Enter' });

    await vi.waitFor(() => expect(vi.mocked(reportSet)).toHaveBeenCalled());
    expect(vi.mocked(reportSet).mock.calls[0][0].confirmReset).toBeFalsy();
  });
});
