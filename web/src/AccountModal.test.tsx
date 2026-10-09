import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AccountModal } from './AccountModal';
import { THEME_KEY } from './theme';

function renderModal() {
  render(
    <AccountModal
      account={{ displayName: 'FireSlam23', startggSlug: 'user/abc', topXBo5: null }}
      accountError={false}
      onClose={vi.fn()}
      onTopXChange={vi.fn()}
      onSignOut={vi.fn()}
    />
  );
}

describe('AccountModal — appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('starts on whatever is already stored, not always on System', () => {
    localStorage.setItem(THEME_KEY, 'light');
    renderModal();

    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('repaints the page and remembers the choice', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Light' }));

    // Both halves matter: the attribute is what the CSS reads, and the stored
    // value is what survives the next load.
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('can go back to following the device', () => {
    localStorage.setItem(THEME_KEY, 'light');
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'System' }));

    expect(localStorage.getItem(THEME_KEY)).toBe('system');
    // matchMedia is stubbed to "no match" in test-setup, so system means dark.
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
