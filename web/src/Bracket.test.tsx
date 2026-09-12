import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Bracket } from './Bracket';
import { MIN_ZOOM } from './bracketZoom';
import type { BracketGroup, BracketSet } from './types';

function set(id: number, identifier: string, round: number, fullRoundText: string): BracketSet {
  return {
    id,
    identifier,
    round,
    fullRoundText,
    state: 1,
    winnerId: null,
    lPlacement: null,
    completedAt: null,
    slots: [
      { entrant: { id: id * 10, name: `P${id}a` }, score: null, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
      { entrant: { id: id * 10 + 1, name: `P${id}b` }, score: null, characterId: null, prereqSetId: null, prereqPlacement: null, progressionOrigin: null },
    ],
    winnerAdvancesToPhase: null,
    loserAdvancesToPhase: null,
  };
}

const GROUP: BracketGroup = {
  phaseGroupId: 1,
  phaseName: 'Bracket',
  displayIdentifier: '1',
  bracketType: 'DOUBLE_ELIMINATION',
  sets: [set(1, 'A', 1, 'Winners Round 1'), set(2, 'B', 1, 'Winners Round 1'), set(3, 'C', 2, 'Winners Final')],
};

/** jsdom lays nothing out, so the stage has to be told how big it is. */
function renderBracket(stageSize = { width: 400, height: 300 }) {
  const { container } = render(
    <div className="bracket-stage">
      <Bracket group={GROUP} onSelectSet={vi.fn()} />
    </div>
  );
  const stage = container.querySelector('.bracket-stage') as HTMLElement;
  Object.defineProperty(stage, 'clientWidth', { value: stageSize.width, configurable: true });
  Object.defineProperty(stage, 'clientHeight', { value: stageSize.height, configurable: true });
  return { container, stage };
}

const canvas = () => document.querySelector('.bracket-canvas') as HTMLElement;
const sizer = () => document.querySelector('.bracket-zoom-sizer') as HTMLElement;
const scaleOf = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1] ?? NaN);
const btn = (label: string) => screen.getByRole('button', { name: label });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('seeing a bracket that does not fit the screen', () => {
  it('starts at normal size', () => {
    renderBracket();
    expect(scaleOf(canvas())).toBe(1);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('pulls back when asked, and says how far', () => {
    renderBracket();
    fireEvent.click(btn('Zoom out'));

    expect(scaleOf(canvas())).toBeLessThan(1);
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('grows the footprint with the zoom, or the bracket cannot be scrolled to', () => {
    // A transform does not change layout, so the scroller keeps the unzoomed
    // range unless something carries the scaled size. Zoomed in, that cut the
    // bracket off at the old width.
    renderBracket();
    const before = sizer().style.width;
    fireEvent.click(btn('Zoom in'));

    expect(parseFloat(sizer().style.width)).toBeGreaterThan(parseFloat(before));
    expect(parseFloat(sizer().style.width)).toBeCloseTo(parseFloat(canvas().style.width) * scaleOf(canvas()), 3);
  });

  it('fits the whole bracket into the space the panel is not covering', () => {
    renderBracket({ width: 400, height: 300 });
    fireEvent.click(screen.getByRole('button', { name: 'fit' }));

    const zoom = scaleOf(canvas());
    expect(parseFloat(canvas().style.width) * zoom).toBeLessThanOrEqual(400);
    expect(parseFloat(canvas().style.height) * zoom).toBeLessThanOrEqual(300);
  });

  it('will not shrink past the floor, and says so by disabling the button', () => {
    renderBracket();
    for (let i = 0; i < 30; i++) fireEvent.click(btn('Zoom out'));

    expect(scaleOf(canvas())).toBe(MIN_ZOOM);
    expect(btn('Zoom out')).toBeDisabled();
  });

  it('offers buttons as well as pinch, which a mouse and a screen reader can use', () => {
    // WCAG 2.5.1: a multipoint gesture needs a single-pointer alternative.
    renderBracket();
    expect(btn('Zoom out')).toBeInTheDocument();
    expect(btn('Zoom in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'fit' })).toBeInTheDocument();
  });
});

describe('remembering how far out the TO works', () => {
  it('is still there after a reload', () => {
    renderBracket();
    fireEvent.click(btn('Zoom out'));
    const chosen = scaleOf(canvas());

    render(
      <div className="bracket-stage">
        <Bracket group={GROUP} onSelectSet={vi.fn()} />
      </div>
    );

    expect(scaleOf(document.querySelectorAll('.bracket-canvas')[1] as HTMLElement)).toBe(chosen);
  });

  it('opens at normal size when the stored value is nonsense', () => {
    localStorage.setItem('smashset.bracketZoom', 'not a number');
    renderBracket();

    expect(scaleOf(canvas())).toBe(1);
  });

  it('opens at normal size when storage cannot be read at all', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    try {
      renderBracket();
      expect(scaleOf(canvas())).toBe(1);
    } finally {
      getItem.mockRestore();
    }
  });
});
