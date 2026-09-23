import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FuzzyCell } from './FuzzyCell';

const ITEMS = [
  { id: 1, name: 'Bayonetta' },
  { id: 2, name: 'Bowser' },
  { id: 3, name: 'Captain Falcon' },
];

function renderCell(over: Partial<Parameters<typeof FuzzyCell>[0]> = {}) {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(<FuzzyCell items={ITEMS} value={null} active onCommit={onCommit} onCancel={onCancel} {...over} />);
  return { onCommit, onCancel, input: () => screen.getByRole('textbox') };
}

describe('FuzzyCell', () => {
  it('commits the top of the list when Enter is pressed with nothing typed', () => {
    // The list is ordered by what this player actually plays, so the top entry
    // is their most-played character — open the cell, press Enter, done. Before
    // the list meant anything, Enter here backed out instead.
    const { onCommit, onCancel, input } = renderCell({ commitTopWhenEmpty: true });

    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith(ITEMS[0]);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('commits whatever the ordering put on top, not the first item passed in', () => {
    // Proves it reads the ranked list rather than the raw one — otherwise the
    // ordering would show in the dropdown but not in what Enter picks.
    const { onCommit } = renderCell({ commitTopWhenEmpty: true, matchItems: (_q, items) => [...items].reverse() });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith(ITEMS[2]);
  });

  it('still commits the highlighted match once something is typed', () => {
    const { onCommit, input } = renderCell();

    fireEvent.change(input(), { target: { value: 'bows' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith(ITEMS[1]);
  });

  it('cancels rather than committing when nothing matches what was typed', () => {
    // An empty list has no top entry to mean anything, so Enter has to be a
    // way out rather than a silent no-op the TO presses twice.
    const { onCommit, onCancel, input } = renderCell();

    fireEvent.change(input(), { target: { value: 'zzzzzz' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('cancels when there is nothing to choose from at all', () => {
    const { onCommit, onCancel } = renderCell({ items: [], commitTopWhenEmpty: true });

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('commits the arrowed-to entry rather than the top one', () => {
    const { onCommit, input } = renderCell({ commitTopWhenEmpty: true });

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onCommit).toHaveBeenCalledWith(ITEMS[1]);
  });

  it('backs out on Enter when the list order carries no claim, as for stages', () => {
    // Stages are not ranked by anything, so committing the first one would be
    // picking a stage for the TO at random. Only cells whose order means
    // something opt in.
    const { onCommit, onCancel } = renderCell();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it('Escape always backs out, typed or not', () => {
    const { onCommit, onCancel, input } = renderCell();

    fireEvent.change(input(), { target: { value: 'bow' } });
    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
