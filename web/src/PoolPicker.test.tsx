import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { PoolPicker, groupIntoPhases } from './PoolPicker';
import { searchEntrants } from './api';
import type { EntrantMatch, PhaseGroupSummary } from './types';

vi.mock('./api', () => ({ searchEntrants: vi.fn() }));

const searchEntrantsMock = vi.mocked(searchEntrants);

let nextId = 1;
function pool(displayIdentifier: string, phaseId: number, phaseName: string, phaseNumSeeds: number): PhaseGroupSummary {
  return { id: nextId++, displayIdentifier, phaseId, phaseName, phaseNumSeeds, bracketType: 'DOUBLE_ELIMINATION' };
}

// Supernova 2026's real shape, including the seed counts, deliberately listed
// in an order no sort would produce by accident.
const SUPERNOVA: PhaseGroupSummary[] = [
  pool('P101', 4, 'Top 24 (BO5)', 24),
  pool('D101', 1, 'Phase 1', 1581),
  pool('R1', 5, 'Top 8 (BO5)', 8),
  pool('N105', 3, 'Phase 3 (BO5)', 128),
  pool('E109', 2, 'Phase 2 (BO5)', 512),
  pool('D102', 1, 'Phase 1', 1581),
  pool('N101', 3, 'Phase 3 (BO5)', 128),
];

function renderPicker(phaseGroups = SUPERNOVA, onPicked = vi.fn(), onBack = vi.fn()) {
  render(
    <PoolPicker eventId={1614806} eventName="Ultimate - 1v1 Singles" phaseGroups={phaseGroups} onPicked={onPicked} onBack={onBack} />
  );
  return { onPicked, onBack };
}

const poolId = (identifier: string) => SUPERNOVA.find((p) => p.displayIdentifier === identifier)!.id;

function lookup(): HTMLInputElement {
  return screen.getByPlaceholderText(/find a player/i) as HTMLInputElement;
}

/** Past the lookup's debounce, then let the resolved promise land. */
async function settleLookup(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe('groupIntoPhases', () => {
  it('orders phases the way start.gg does, which phaseOrder would not', () => {
    // start.gg reports phaseOrder 2, 7, 4, 5, 6 for these, which would put
    // Phase 2 last. Seed count is what actually matches its bracket page.
    expect(groupIntoPhases(SUPERNOVA).map((p) => p.name)).toEqual([
      'Phase 1',
      'Phase 2 (BO5)',
      'Phase 3 (BO5)',
      'Top 24 (BO5)',
      'Top 8 (BO5)',
    ]);
  });

  it('sorts pools numerically, so A9 comes before A10', () => {
    const phases = groupIntoPhases([pool('A10', 1, 'Phase 1', 64), pool('A9', 1, 'Phase 1', 64), pool('A2', 1, 'Phase 1', 64)]);
    expect(phases[0].pools.map((p) => p.displayIdentifier)).toEqual(['A2', 'A9', 'A10']);
  });

  it('keeps every pool, grouped under its own phase', () => {
    const phases = groupIntoPhases(SUPERNOVA);
    expect(phases.map((p) => p.pools.length)).toEqual([2, 1, 2, 1, 1]);
  });
});

describe('PoolPicker', () => {
  it('puts back above the phases, not below every pool', () => {
    renderPicker();
    const back = screen.getByRole('button', { name: /back/i });
    const phase = screen.getByRole('button', { name: /Phase 1/ });

    // The original bug: one back button, stranded under 64 pools, so on a real
    // event it was off the bottom of the screen and looked absent.
    expect(back.compareDocumentPosition(phase) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts with every phase collapsed and no pools rendered', () => {
    renderPicker();

    expect(screen.getByRole('button', { name: /Phase 1/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('D101')).not.toBeInTheDocument();
  });

  it('expands a phase in place, without leaving the screen', () => {
    renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /Phase 1/ }));

    expect(screen.getByText('D101')).toBeInTheDocument();
    expect(screen.getByText('D102')).toBeInTheDocument();
    // Only that phase opened; the rest stay out of the way.
    expect(screen.queryByText('E109')).not.toBeInTheDocument();
  });

  it('picks the pool that was clicked', () => {
    const { onPicked } = renderPicker();

    fireEvent.click(screen.getByRole('button', { name: /Phase 3/ }));
    fireEvent.click(screen.getByText('N105'));

    expect(onPicked).toHaveBeenCalledWith(SUPERNOVA.find((p) => p.displayIdentifier === 'N105')!.id);
  });

  it('collapses a phase that is clicked again', () => {
    renderPicker();
    const phase1 = screen.getByRole('button', { name: /Phase 1/ });

    fireEvent.click(phase1);
    fireEvent.click(phase1);

    expect(screen.queryByText('D101')).not.toBeInTheDocument();
  });

  it('counts the brackets in each phase', () => {
    renderPicker();
    expect(screen.getByRole('button', { name: /Phase 1/ })).toHaveTextContent('2 brackets');
    expect(screen.getByRole('button', { name: /Top 8/ })).toHaveTextContent('1 bracket');
  });
});

describe('PoolPicker — player lookup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchEntrantsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const deepRun: EntrantMatch = {
    id: 1,
    name: 'FaZe | Sparg0',
    phaseGroupIds: [poolId('D101'), poolId('E109'), poolId('N101'), poolId('P101'), poolId('R1')],
  };
  const poolsOnly: EntrantMatch = { id: 2, name: 'JL | Zoruya', phaseGroupIds: [poolId('D102')] };

  it('does nothing at all for one or two characters', async () => {
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'sp' } });
    await settleLookup();

    // Not a debounce that eventually fires — no request is made at any point.
    // "a" alone matches 900 of this event's 1581 entrants.
    expect(searchEntrantsMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Phase 1/ })).toHaveTextContent('2 brackets');
  });

  it('searches once the query is long enough', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [deepRun] });
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'spa' } });
    await settleLookup();

    expect(searchEntrantsMock).toHaveBeenCalledWith(1614806, 'spa');
  });

  it('debounces, so typing a name is one request and not six', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [deepRun] });
    renderPicker();

    for (const value of ['spa', 'spar', 'sparg', 'sparg0']) {
      fireEvent.change(lookup(), { target: { value } });
      await vi.advanceTimersByTimeAsync(50);
    }
    await settleLookup();

    expect(searchEntrantsMock).toHaveBeenCalledTimes(1);
    expect(searchEntrantsMock).toHaveBeenLastCalledWith(1614806, 'sparg0');
  });

  it('narrows every phase to that player and opens them, on a single match', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [deepRun] });
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'sparg0' } });
    await settleLookup();

    // Their run, one pool per phase, without expanding anything by hand.
    expect(screen.getByText('D101')).toBeInTheDocument();
    expect(screen.getByText('E109')).toBeInTheDocument();
    expect(screen.getByText('R1')).toBeInTheDocument();
    // The pool they were never in is gone, even though it shares the phase.
    expect(screen.queryByText('D102')).not.toBeInTheDocument();
  });

  it('marks the phases a player never reached', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [poolsOnly] });
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'zoruya' } });
    await settleLookup();

    expect(screen.getByText('D102')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Top 8/ })).toHaveTextContent('did not reach');
    expect(screen.getByRole('button', { name: /Phase 2/ })).toHaveTextContent('did not reach');
  });

  it('asks which player when the name is ambiguous, rather than guessing', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [deepRun, poolsOnly] });
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'zor' } });
    await settleLookup();

    // Both are offered and nothing is narrowed, because picking one for them
    // would be guessing which player they meant.
    expect(screen.getByText('FaZe | Sparg0')).toBeInTheDocument();
    expect(screen.getByText('JL | Zoruya')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Phase 1/ })).toHaveTextContent('2 brackets');
    expect(screen.getByRole('button', { name: /Top 8/ })).not.toHaveTextContent('did not reach');

    fireEvent.click(screen.getByText('JL | Zoruya'));

    expect(screen.getByRole('button', { name: /Top 8/ })).toHaveTextContent('did not reach');
  });

  it('says so when nobody matches', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [] });
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'nobodyhere' } });
    await settleLookup();

    expect(screen.getByText(/No player matching "nobodyhere"/)).toBeInTheDocument();
  });

  it('shows a failed lookup instead of silently listing every pool', async () => {
    searchEntrantsMock.mockRejectedValue(new Error('start.gg is down'));
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'sparg0' } });
    await settleLookup();

    expect(screen.getByText('start.gg is down')).toBeInTheDocument();
  });

  it('goes back to every pool when the lookup is cleared', async () => {
    searchEntrantsMock.mockResolvedValue({ entrants: [poolsOnly] });
    renderPicker();

    fireEvent.change(lookup(), { target: { value: 'zoruya' } });
    await settleLookup();
    fireEvent.click(screen.getByRole('button', { name: /show all/i }));
    await settleLookup();

    expect(screen.getByRole('button', { name: /Phase 1/ })).toHaveTextContent('2 brackets');
    expect(screen.getByText('D101')).toBeInTheDocument();
  });
});
