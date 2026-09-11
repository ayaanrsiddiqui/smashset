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
