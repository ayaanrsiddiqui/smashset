import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { Delayed, LOADING_DELAY_MS, LoadingNote, SkeletonRows } from './Loading';

describe('Delayed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows nothing until the wait is long enough to be worth mentioning', () => {
    render(
      <Delayed>
        <p>waiting</p>
      </Delayed>
    );

    // The point of the delay: an answer that arrives in 80ms renders straight
    // into content, with no indicator flashing in front of it.
    expect(screen.queryByText('waiting')).toBeNull();
    act(() => vi.advanceTimersByTime(LOADING_DELAY_MS - 1));
    expect(screen.queryByText('waiting')).toBeNull();
  });

  it('shows its children once the wait passes the threshold', () => {
    render(
      <Delayed>
        <p>waiting</p>
      </Delayed>
    );

    act(() => vi.advanceTimersByTime(LOADING_DELAY_MS));
    expect(screen.getByText('waiting')).toBeInTheDocument();
  });

  it('drops its timer when it unmounts mid-wait', () => {
    const { unmount } = render(
      <Delayed>
        <p>waiting</p>
      </Delayed>
    );

    unmount();
    // A setState on an unmounted component is a React warning, not a thrown
    // error, so the assertion that matters is that nothing is left pending.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the shapes a wait can take', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces a loading note as a status, so the wait is not silent', () => {
    render(<LoadingNote>Checking your session…</LoadingNote>);
    act(() => vi.advanceTimersByTime(LOADING_DELAY_MS));

    expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
  });

  it('draws the asked-for number of placeholder rows, hidden from assistive tech', () => {
    const { container } = render(
      <ul>
        <SkeletonRows count={3} />
      </ul>
    );
    act(() => vi.advanceTimersByTime(LOADING_DELAY_MS));

    const rows = container.querySelectorAll('li.skeleton-row');
    expect(rows).toHaveLength(3);
    // The shapes say nothing a screen reader can use; the list carries
    // aria-busy instead (see SetPanel).
    for (const row of rows) expect(row.getAttribute('aria-hidden')).toBe('true');
  });
});
