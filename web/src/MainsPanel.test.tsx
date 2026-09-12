import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MainsPanel } from './MainsPanel';
import { fetchPoolPlayers } from './api';
import type { Character, PoolPlayer } from './types';

vi.mock('./api', () => ({ fetchPoolPlayers: vi.fn() }));
const fetchPoolPlayersMock = vi.mocked(fetchPoolPlayers);

const FOX: Character = { id: 100, name: 'Fox', imageUrl: 'https://example.test/fox.png' };
const FALCO: Character = { id: 200, name: 'Falco' };

const PLAYERS: PoolPlayer[] = [
  { playerId: 11, name: 'Ada', main: { characterId: 100, gamesTallied: 9, setsConsidered: 3 } },
  { playerId: 12, name: 'mudd', main: { characterId: null, gamesTallied: 0, setsConsidered: 4 } },
  // Nobody has looked this player up yet. Opening the panel starts one, so the
  // panel says "looking up…" — distinct from having looked and found nothing.
  { playerId: 13, name: 'Newcomer', main: null },
];

function renderPanel(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(<MainsPanel phaseGroupId={1} characters={[FOX, FALCO]} onClose={vi.fn()} onSave={onSave} />);
  return onSave;
}

describe('MainsPanel', () => {
  beforeEach(() => {
    fetchPoolPlayersMock.mockReset();
    fetchPoolPlayersMock.mockResolvedValue({ players: PLAYERS, videogameId: 1386 });
  });

  it('lists the whole pool, not only players with a set still to play', async () => {
    renderPanel();

    // The open-sets list would miss anyone whose current set is finished, and
    // mains are most useful filled in before anything starts.
    await waitFor(() => expect(fetchPoolPlayersMock).toHaveBeenCalledWith(1));
    expect(await screen.findByLabelText('Main for Newcomer')).toBeInTheDocument();
  });

  it('sorts by name so a TO can find someone', async () => {
    fetchPoolPlayersMock.mockResolvedValue({
      players: [PLAYERS[2], PLAYERS[0], PLAYERS[1]],
      videogameId: 1386,
    });
    renderPanel();

    await waitFor(() => expect(document.querySelectorAll('.mains-list li')).toHaveLength(3));
    expect([...document.querySelectorAll('.mains-name')].map((e) => e.textContent)).toEqual(['Ada', 'mudd', 'Newcomer']);
  });

  it('says only what the dropdown beside it cannot', async () => {
    // A character already on file is named by the dropdown, so repeating it
    // here made every filled-in row say the same thing twice. The absences are
    // the part worth a word, and "never looked" is not "looked and found
    // nothing".
    renderPanel();
    await waitFor(() => expect(document.querySelectorAll('.mains-list li')).toHaveLength(3));

    expect([...document.querySelectorAll('.mains-list li')].map((li) => [
      li.querySelector('.mains-name')?.textContent,
      li.querySelector('.mains-current')?.textContent ?? null,
    ])).toEqual([
      ['Ada', null],
      ['mudd', 'no main found'],
      ['Newcomer', 'looking up…'],
    ]);
  });

  it('keeps the icon with the dropdown that names the character', async () => {
    renderPanel();
    await waitFor(() => expect(document.querySelectorAll('.mains-list li')).toHaveLength(3));

    const ada = [...document.querySelectorAll('.mains-list li')].find((li) => li.textContent?.includes('Ada'));
    expect(ada?.querySelector('.mains-pick img.mains-icon')).not.toBeNull();
  });

  it('saves the character a TO picks and shows it at once', async () => {
    const onSave = renderPanel();
    fireEvent.change(await screen.findByLabelText('Main for Newcomer'), { target: { value: '200' } });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(13, 200));
    // Reflected locally rather than on a refetch — the panel has no poll. The
    // dropdown is where the pick shows now, and the "looking up…" note goes.
    await waitFor(() => {
      const row = [...document.querySelectorAll('.mains-list li')].find((li) => li.textContent?.includes('Newcomer'));
      expect((row?.querySelector('select') as HTMLSelectElement | null)?.value).toBe('200');
      expect(row?.querySelector('.mains-current')).toBeNull();
    });
  });

  it('can clear a main rather than only replace it', async () => {
    // Clearing a wrong guess is its own action; leaving it because the TO has
    // nothing better to put there would keep mis-prefilling.
    const onSave = renderPanel();
    fireEvent.change(await screen.findByLabelText('Main for Ada'), { target: { value: '' } });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(11, null));
  });

  it('shows a failed save instead of pretending it worked', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Database is down'));
    renderPanel(onSave);
    fireEvent.change(await screen.findByLabelText('Main for Newcomer'), { target: { value: '100' } });

    expect(await screen.findByText('Database is down')).toBeInTheDocument();
  });

  it('shows a failed load instead of an empty list', async () => {
    // An empty panel reads as "this pool has no players", which is a different
    // and much more alarming thing than "the request failed".
    fetchPoolPlayersMock.mockRejectedValue(new Error('start.gg is down'));
    renderPanel();

    expect(await screen.findByText('start.gg is down')).toBeInTheDocument();
  });

  it('says so plainly when the pool has nobody seeded yet', async () => {
    fetchPoolPlayersMock.mockResolvedValue({ players: [], videogameId: 1386 });
    renderPanel();

    expect(await screen.findByText(/No players seeded into this pool yet/)).toBeInTheDocument();
  });
});
