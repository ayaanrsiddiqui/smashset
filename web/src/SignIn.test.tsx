import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignIn } from './SignIn';

describe('SignIn', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    // jsdom's window.location.href setter actually tries to navigate (and
    // logs a "not implemented" error) — stub it so we can just assert on
    // the assignment instead.
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, href: '' },
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('shows the quickset name and a sign-in call to action', () => {
    render(<SignIn />);
    expect(screen.getByRole('heading', { name: 'quickset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('navigates to /api/auth/login on click — a full navigation, not a fetch, since the user must land on start.gg', async () => {
    render(<SignIn />);
    await userEvent.click(screen.getByRole('button', { name: /sign in with start\.gg/i }));
    expect(window.location.href).toBe('/api/auth/login');
  });
});
