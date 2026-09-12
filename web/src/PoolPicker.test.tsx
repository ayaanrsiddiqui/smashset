import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PoolPicker, groupIntoPhases } from './PoolPicker';
import type { PhaseGroupSummary } from './types';

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
  render(<PoolPicker eventName="Ultimate - 1v1 Singles" phaseGroups={phaseGroups} onPicked={onPicked} onBack={onBack} />);
  return { onPicked, onBack };
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
