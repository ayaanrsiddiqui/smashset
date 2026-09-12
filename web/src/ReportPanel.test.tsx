import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ReportPanel } from './ReportPanel';
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
