import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchMeMock = vi.fn();
const logoutMock = vi.fn();

vi.mock('./api', () => ({
  fetchMe: (...args: unknown[]) => fetchMeMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
  resolveEvent: vi.fn(),
  fetchOpenSets: vi.fn().mockResolvedValue({ sets: [] }),
  fetchCharacters: vi.fn().mockResolvedValue({ characters: [] }),
  fetchStages: vi.fn().mockResolvedValue({ stages: [] }),
  startSet: vi.fn(),
}));

// Imported after the mock is registered so App picks up the mocked ./api.
const { default: App } = await import('./App');

describe('App — sign-in gate', () => {
  beforeEach(() => {
    localStorage.clear();
    logoutMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
    logoutMock.mockReset();
  });

  it('shows a bare loading state before the /api/me check resolves', () => {
    fetchMeMock.mockReturnValue(new Promise(() => {})); // never resolves during this test
    render(<App />);

    expect(screen.getByRole('heading', { name: 'SmashSet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/tournament or event/i)).not.toBeInTheDocument();
  });

  it('shows Sign In once /api/me resolves to no user', async () => {
    fetchMeMock.mockResolvedValue({ user: null });
    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('skips Sign In and shows the event picker once /api/me resolves to a real user (no cached event)', async () => {
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    render(<App />);

    expect(await screen.findByPlaceholderText(/start\.gg\/my-tournament/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with start\.gg/i })).not.toBeInTheDocument();
  });

  it('treats a failed /api/me check the same as "not signed in", not stuck loading forever', async () => {
    fetchMeMock.mockRejectedValue(new Error('network error'));
    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });

  it('sign out calls the API and returns to the Sign In screen', async () => {
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'small bracket',
        slug: 'tournament/x/event/small-bracket',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
    render(<App />);

    const signOutBtn = await screen.findByRole('button', { name: 'sign out' });
    await userEvent.click(signOutBtn);

    expect(logoutMock).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: /sign in with start\.gg/i })).toBeInTheDocument();
  });
});

describe('App — help modal', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      'smashset.event',
      JSON.stringify({
        id: 1,
        name: 'small bracket',
        slug: 'tournament/x/event/small-bracket',
        videogame: { id: 1, name: 'Melee' },
        tournament: { id: 1, name: 'x' },
      })
    );
    fetchMeMock.mockResolvedValue({ user: { id: 1, displayName: 'FireSlam23' } });
  });

  afterEach(() => {
    fetchMeMock.mockReset();
  });

  it('opens the notation guide from the header and closes it again', async () => {
    render(<App />);

    const trigger = await screen.findByRole('button', { name: 'Notation guide' });
    await userEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: 'SmashSet notation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The sweep' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Full reference' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: 'Notation guide' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
