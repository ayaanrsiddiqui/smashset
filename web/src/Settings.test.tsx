import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Settings } from './Settings';
import { resolveEvent } from './api';

vi.mock('./api', () => ({ resolveEvent: vi.fn() }));

const resolveEventMock = vi.mocked(resolveEvent);

describe('Settings — the start.gg/ field', () => {
  beforeEach(() => {
    resolveEventMock.mockReset();
    resolveEventMock.mockResolvedValue({ events: [] });
  });

  function field(): HTMLInputElement {
    return screen.getByLabelText(/tournament or event/i) as HTMLInputElement;
  }

  it('shows the prefix the slug will be resolved against', () => {
    render(<Settings onResolved={vi.fn()} />);
    expect(screen.getByText('start.gg/')).toBeInTheDocument();
  });

  it('sends a bare slug through untouched', async () => {
    render(<Settings onResolved={vi.fn()} />);

    fireEvent.change(field(), { target: { value: 'supernova' } });
    fireEvent.keyDown(field(), { key: 'Enter' });

    expect(resolveEventMock).toHaveBeenCalledWith('supernova');
  });

  it('folds a pasted full URL down to its path, so the prefix stays true', () => {
    render(<Settings onResolved={vi.fn()} />);

    // Otherwise the field would read "start.gg/https://start.gg/…".
    fireEvent.change(field(), { target: { value: 'https://www.start.gg/tournament/supernova-2026/event/singles' } });

    expect(field().value).toBe('tournament/supernova-2026/event/singles');
  });

  it('leaves a slug that merely contains the host alone', () => {
    render(<Settings onResolved={vi.fn()} />);

    // Only a leading host is a prefix; stripping mid-string would corrupt it.
    fireEvent.change(field(), { target: { value: 'not-start.gg/thing' } });

    expect(field().value).toBe('not-start.gg/thing');
  });
});

/**
 * "switch event" used to drop the TO back on an empty slug field, so changing
 * event meant retyping the tournament they were already in. It now reopens
 * that tournament's event list.
 */
describe('Settings — reopening the tournament already in use', () => {
  const EVENT = (id: number, name: string) => ({
    id,
    name,
    slug: `tournament/t/event/${name}`,
    videogame: { id: 1, name: 'Ultimate' },
    tournament: { id: 1, name: 'Definitely Real Tournament' },
  });

  beforeEach(() => {
    resolveEventMock.mockReset();
  });

  it('opens straight on the event list, without being asked for a slug', async () => {
    resolveEventMock.mockResolvedValue({ events: [EVENT(1, 'singles'), EVENT(2, 'doubles')] });
    render(<Settings onResolved={vi.fn()} initialInput="fireslam23test" />);

    expect(await screen.findByText('singles')).toBeInTheDocument();
    expect(screen.getByText('doubles')).toBeInTheDocument();
    expect(resolveEventMock).toHaveBeenCalledWith('fireslam23test');
  });

  it('does not bounce straight back in when the tournament has only one event', async () => {
    // Auto-selecting here would return the TO to the exact screen they just
    // pressed "switch event" to leave.
    const onResolved = vi.fn();
    resolveEventMock.mockResolvedValue({ event: EVENT(1, 'singles') });
    render(<Settings onResolved={onResolved} initialInput="fireslam23test" />);

    expect(await screen.findByText('singles')).toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('still offers a way to a different tournament', async () => {
    resolveEventMock.mockResolvedValue({ events: [EVENT(1, 'singles')] });
    render(<Settings onResolved={vi.fn()} initialInput="fireslam23test" />);
    fireEvent.click(await screen.findByRole('button', { name: 'different tournament' }));

    expect(screen.getByLabelText(/tournament or event/i)).toBeInTheDocument();
  });

  it('picking an event reports what was typed to reach it, so it can be reopened', async () => {
    const onResolved = vi.fn();
    resolveEventMock.mockResolvedValue({ events: [EVENT(1, 'singles'), EVENT(2, 'doubles')] });
    render(<Settings onResolved={onResolved} initialInput="fireslam23test" />);

    fireEvent.click(await screen.findByText('doubles'));

    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ name: 'doubles' }), 'fireslam23test');
  });

  it('still asks for a slug when there is nothing to reopen', () => {
    render(<Settings onResolved={vi.fn()} />);
    expect(screen.getByLabelText(/tournament or event/i)).toBeInTheDocument();
    expect(resolveEventMock).not.toHaveBeenCalled();
  });

  it('auto-selects a lone event when the TO typed the slug themselves', async () => {
    // The opposite case: typing a slug and getting one event should just go.
    const onResolved = vi.fn();
    resolveEventMock.mockResolvedValue({ event: EVENT(1, 'singles') });
    render(<Settings onResolved={onResolved} />);

    fireEvent.change(screen.getByLabelText(/tournament or event/i), { target: { value: 'fireslam23test' } });
    fireEvent.keyDown(screen.getByLabelText(/tournament or event/i), { key: 'Enter' });

    await vi.waitFor(() => expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ name: 'singles' }), 'fireslam23test'));
  });
});
