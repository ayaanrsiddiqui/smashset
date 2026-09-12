import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OutboxStrip } from './OutboxStrip';
import type { OutboxEntry } from './outbox';

function entry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    setId: '1',
    payload: { setId: 1, winnerEntrantId: 10, loserEntrantId: 20, requiredWins: 2, shorthand: '+' },
    label: 'Ada vs mudd',
    attempt: 1,
    nextAttemptAt: 0,
    state: 'sending',
    error: null,
    queuedAt: 0,
    ...over,
  };
}

describe('OutboxStrip', () => {
  it('shows nothing when everything has landed', () => {
    const { container } = render(<OutboxStrip entries={[]} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the set it is still sending, rather than a bare count', () => {
    render(<OutboxStrip entries={[entry()]} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByText(/Sending Ada vs mudd/)).toBeInTheDocument();
  });

  it('never says a report was made while it is still sending', () => {
    render(<OutboxStrip entries={[entry()]} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.queryByText(/reported/i)).not.toBeInTheDocument();
  });

  it('says when a report is struggling, before the TO walks away from the set', () => {
    render(
      <OutboxStrip entries={[entry({ attempt: 4, error: 'Could not reach the server.' })]} onRetry={vi.fn()} onDiscard={vi.fn()} />
    );
    expect(screen.getByText(/4 tries — Could not reach the server\./)).toBeInTheDocument();
  });

  it('stays quiet about a first attempt, which is just a report in flight', () => {
    render(<OutboxStrip entries={[entry({ attempt: 1 })]} onRetry={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.queryByText(/tries/)).not.toBeInTheDocument();
  });

  it('shouts about one that has given up, and says which set and why', () => {
    render(
      <OutboxStrip
        entries={[entry({ state: 'failed', error: 'This set is between different players now.' })]}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    expect(screen.getByText('NOT REPORTED')).toBeInTheDocument();
    expect(screen.getByText('Ada vs mudd')).toBeInTheDocument();
    expect(screen.getByText('This set is between different players now.')).toBeInTheDocument();
  });

  it('lists every dead-lettered report, not just the first', () => {
    render(
      <OutboxStrip
        entries={[
          entry({ setId: '1', label: 'Ada vs mudd', state: 'failed' }),
          entry({ setId: '2', label: 'Bo vs Cy', state: 'failed' }),
        ]}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    expect(screen.getAllByText('NOT REPORTED')).toHaveLength(2);
  });

  it('lets the TO send a dead-lettered report again', () => {
    const onRetry = vi.fn();
    render(<OutboxStrip entries={[entry({ state: 'failed' })]} onRetry={onRetry} onDiscard={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'try again' }));

    expect(onRetry).toHaveBeenCalledWith('1');
  });

  it('lets the TO throw one away once they have dealt with it another way', () => {
    const onDiscard = vi.fn();
    render(<OutboxStrip entries={[entry({ state: 'failed' })]} onRetry={vi.fn()} onDiscard={onDiscard} />);

    fireEvent.click(screen.getByRole('button', { name: 'discard' }));

    expect(onDiscard).toHaveBeenCalledWith('1');
  });

  it('shows a failure and something still sending at the same time', () => {
    render(
      <OutboxStrip
        entries={[entry({ setId: '1', label: 'Ada vs mudd', state: 'failed' }), entry({ setId: '2', label: 'Bo vs Cy' })]}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
      />
    );
    expect(screen.getByText('NOT REPORTED')).toBeInTheDocument();
    expect(screen.getByText(/Sending Bo vs Cy/)).toBeInTheDocument();
  });
});
