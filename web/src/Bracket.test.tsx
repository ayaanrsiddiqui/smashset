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
      { entrant: { id: id * 10, name: `P${id}a` }, score: null, characterIds: [], prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
      { entrant: { id: id * 10 + 1, name: `P${id}b` }, score: null, characterIds: [], prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: null },
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

/**
 * The seed on one edge and the upset factor on the other, the way
 * supermajor.gg reads: what the bracket expected, and by how much it was
 * wrong.
 */
describe('what a set says about seeding', () => {
  function played(winnerSeed: number, loserSeed: number, state = 3): BracketGroup {
    return {
      phaseGroupId: 1,
      phaseName: 'Bracket',
      displayIdentifier: '1',
      bracketType: 'DOUBLE_ELIMINATION',
      sets: [
        {
          ...set(1, 'A', 1, 'Winners Round 1'),
          state,
          winnerId: state === 3 ? 10 : null,
          slots: [
            { entrant: { id: 10, name: 'Winner' }, score: 2, characterIds: [], prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: winnerSeed },
            { entrant: { id: 20, name: 'Loser' }, score: 0, characterIds: [], prereqSetId: null, prereqPlacement: null, progressionOrigin: null, seedNum: loserSeed },
          ],
        },
      ],
    };
  }

  const upsetBadge = () => document.querySelector('.bracket-upset');

  function renderGroup(group: BracketGroup) {
    render(
      <div className="bracket-stage">
        <Bracket group={group} onSelectSet={vi.fn()} />
      </div>
    );
  }

  it('shows each entrant seed', () => {
    renderGroup(played(7, 2));
    expect([...document.querySelectorAll('.bracket-seed')].map((e) => e.textContent)).toEqual(['7', '2']);
  });

  it('scores an upset by how many placement tiers it jumped', () => {
    renderGroup(played(7, 2));
    expect(upsetBadge()?.textContent).toBe('4');
    expect(upsetBadge()?.className).toContain('real');
  });

  it('just ticks when the seeding held', () => {
    renderGroup(played(2, 7));
    expect(upsetBadge()?.textContent).toBe('✓');
    expect(upsetBadge()?.className).not.toContain('real');
  });

  it('says nothing about a set nobody has played', () => {
    renderGroup(played(7, 2, 1));
    expect(upsetBadge()).toBeNull();
  });

  it('says nothing when the seeds are not known yet', () => {
    // Seeds ride the bracket's slow structure fetch, so a slot filled in the
    // last minute has none — which is not the same as "no upset".
    renderGroup(played(null as unknown as number, 2));
    expect(upsetBadge()).toBeNull();
  });

  it('keeps the character beside the score rather than the tag', () => {
    const group = played(7, 2);
    group.sets[0].slots[0] = { ...group.sets[0].slots[0], characterIds: [100] };
    render(
      <div className="bracket-stage">
        <Bracket group={group} onSelectSet={vi.fn()} characters={[{ id: 100, name: 'Fox', imageUrl: 'f.png' }]} />
      </div>
    );

    const row = document.querySelector('.bracket-row');
    const order = [...(row?.children ?? [])].map((el) => el.className.split(' ')[0]);
    expect(order).toEqual(['bracket-seed', 'bracket-name', 'bracket-characters', 'bracket-score']);
  });

  it('shows every character a player used, most of the set first', () => {
    const group = played(7, 2);
    // Already ranked by the server; the row renders them in the order given.
    group.sets[0].slots[0] = { ...group.sets[0].slots[0], characterIds: [100, 200] };
    render(
      <div className="bracket-stage">
        <Bracket
          group={group}
          onSelectSet={vi.fn()}
          characters={[
            { id: 100, name: 'Fox', imageUrl: 'fox.png' },
            { id: 200, name: 'Falco', imageUrl: 'falco.png' },
          ]}
        />
      </div>
    );

    const icons = [...document.querySelectorAll('.bracket-row .bracket-character')].map((el) => el.getAttribute('src'));
    expect(icons).toEqual(['fox.png', 'falco.png']);
  });

  it('shows at most three, so the icons cannot crowd out the tag', () => {
    const group = played(7, 2);
    group.sets[0].slots[0] = { ...group.sets[0].slots[0], characterIds: [100, 200, 300, 400] };
    render(
      <div className="bracket-stage">
        <Bracket
          group={group}
          onSelectSet={vi.fn()}
          characters={[100, 200, 300, 400].map((id) => ({ id, name: `C${id}`, imageUrl: `${id}.png` }))}
        />
      </div>
    );

    const icons = [...document.querySelectorAll('.bracket-row .bracket-character')].map((el) => el.getAttribute('src'));
    expect(icons).toEqual(['100.png', '200.png', '300.png']);
  });

  it('does not spend one of the three on a character it has no icon for', () => {
    const group = played(7, 2);
    // 200 is missing from the videogame's character list, as happens when the
    // list and the set's picks disagree.
    group.sets[0].slots[0] = { ...group.sets[0].slots[0], characterIds: [100, 200, 300, 400] };
    render(
      <div className="bracket-stage">
        <Bracket
          group={group}
          onSelectSet={vi.fn()}
          characters={[100, 300, 400].map((id) => ({ id, name: `C${id}`, imageUrl: `${id}.png` }))}
        />
      </div>
    );

    const icons = [...document.querySelectorAll('.bracket-row .bracket-character')].map((el) => el.getAttribute('src'));
    expect(icons).toEqual(['100.png', '300.png', '400.png']);
  });

  it('renders no icon group at all when the set carries no picks', () => {
    const group = played(7, 2);
    render(
      <div className="bracket-stage">
        <Bracket group={group} onSelectSet={vi.fn()} characters={[{ id: 100, name: 'Fox', imageUrl: 'fox.png' }]} />
      </div>
    );

    expect(document.querySelector('.bracket-characters')).toBeNull();
  });
});
