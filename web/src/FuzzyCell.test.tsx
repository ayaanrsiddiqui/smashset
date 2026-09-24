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

  describe('when the cell has a body action', () => {
    function renderSplit(over: Record<string, unknown> = {}) {
      const onFocusRequest = vi.fn();
      const onBodyClick = vi.fn();
      render(
        <FuzzyCell
          items={ITEMS}
          value={{ id: 1, name: 'Bayonetta', imageUrl: 'bayo.png' }}
          active={false}
          onCommit={vi.fn()}
          onCancel={vi.fn()}
          onFocusRequest={onFocusRequest}
          onBodyClick={onBodyClick}
          pickLabel="choose character"
          bodyLabel="won the game"
          {...over}
        />
      );
      return { onFocusRequest, onBodyClick };
    }

    it('opens the picker from the icon box only', () => {
      const { onFocusRequest, onBodyClick } = renderSplit();

      fireEvent.click(screen.getByLabelText('choose character'));

      expect(onFocusRequest).toHaveBeenCalled();
      expect(onBodyClick).not.toHaveBeenCalled();
    });

    it('does the body action from the rest of the cell', () => {
      // The whole point: the big target is the common action, not the picker.
      const { onFocusRequest, onBodyClick } = renderSplit();

      fireEvent.click(screen.getByLabelText('won the game'));

      expect(onBodyClick).toHaveBeenCalled();
      expect(onFocusRequest).not.toHaveBeenCalled();
    });

    it('still offers a way into the picker with no character set', () => {
      // The trap. There is no icon to aim at before a character is chosen, so
      // an icon box rendered only when filled would leave the empty cell —
      // the one most in need of picking — unreachable by mouse.
      const { onFocusRequest } = renderSplit({ value: null });

      fireEvent.click(screen.getByLabelText('choose character'));

      expect(onFocusRequest).toHaveBeenCalled();
    });

    it('keeps the same box, so the row tints and sizing still apply', () => {
      // Every rule for the won/queued tint and the fixed row height is written
      // against .fuzzy-cell. Splitting the insides must not move that class.
      renderSplit({ multiSelect: true });

      const cell = document.querySelector('.fuzzy-cell');
      expect(cell).not.toBeNull();
      expect(cell!.classList.contains('queued')).toBe(true);
      expect(cell!.querySelector('.fuzzy-cell-pick')).not.toBeNull();
      expect(cell!.querySelector('.fuzzy-cell-body')).not.toBeNull();
    });
  });

  it('stays one button, opening the picker from anywhere, without a body action', () => {
    // Stage cells and the all-games cells have nothing else to do, so they are
    // deliberately left exactly as they were.
    const onFocusRequest = vi.fn();
    render(
      <FuzzyCell items={ITEMS} value={null} active={false} onCommit={vi.fn()} onCancel={vi.fn()} onFocusRequest={onFocusRequest} />
    );

    expect(document.querySelectorAll('.fuzzy-cell-pick')).toHaveLength(0);
    fireEvent.click(document.querySelector('.fuzzy-cell')!);

    expect(onFocusRequest).toHaveBeenCalled();
  });

  it('Escape always backs out, typed or not', () => {
    const { onCommit, onCancel, input } = renderCell();

    fireEvent.change(input(), { target: { value: 'bow' } });
    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
