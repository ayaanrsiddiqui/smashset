import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MainsPanel, playersNeedingMains } from './MainsPanel';
import type { Character, OpenSet } from './types';

const FOX: Character = { id: 100, name: 'Fox', imageUrl: 'https://example.test/fox.png' };
const FALCO: Character = { id: 200, name: 'Falco' };

function set(id: number, entrants: OpenSet['entrants']): OpenSet {
  return { id, isPreview: false, isStarted: false, fullRoundText: 'Winners Round 1', identifier: 'A', lPlacement: null, entrants };
}

describe('playersNeedingMains', () => {
  it('lists each player once, in name order', () => {
    const sets = [
      set(1, [
        { id: 1, name: 'Zoruya', playerId: 10 },
        { id: 2, name: 'Ada', playerId: 11 },
      ]),
      // Ada plays again later; she is still one player.
      set(2, [
        { id: 3, name: 'Ada', playerId: 11 },
        { id: 4, name: 'mudd', playerId: 12 },
      ]),
    ];
    expect(playersNeedingMains(sets).map((p) => p.name)).toEqual(['Ada', 'mudd', 'Zoruya']);
  });

  it('skips an entrant with no player id, since a main cannot be keyed to it', () => {
    // Entrant ids are per-event; a main keyed to one would not survive the
    // tournament it was set at, which defeats the point.
    const sets = [set(1, [{ id: 1, name: 'No Player Id' }, { id: 2, name: 'Ada', playerId: 11 }])];
    expect(playersNeedingMains(sets).map((p) => p.name)).toEqual(['Ada']);
  });
});

describe('MainsPanel', () => {
  const sets = [
    set(1, [
      { id: 1, name: 'Ada', playerId: 11, suggestedMain: { characterId: 100, gamesTallied: 9, setsConsidered: 3 } },
      { id: 2, name: 'mudd', playerId: 12, suggestedMain: { characterId: null, setsConsidered: 4, gamesTallied: 0 } },
    ]),
    set(2, [{ id: 3, name: 'Newcomer', playerId: 13 }]),
  ];

  function renderPanel(onSave = vi.fn().mockResolvedValue(undefined)) {
    render(<MainsPanel sets={sets} characters={[FOX, FALCO]} videogameId={1386} onClose={vi.fn()} onSave={onSave} />);
    return onSave;
  }

  it('distinguishes a known main, a confirmed absence, and a lookup still running', () => {
    renderPanel();
    // Read the status column specifically — every character also appears as an
    // <option> in every row's select.
    const status = [...document.querySelectorAll('.mains-list li')].map((li) => [
      li.querySelector('.mains-name')?.textContent,
      li.querySelector('.mains-current')?.textContent,
    ]);
    // "not looked yet" and "looked and found nothing" are different facts, and
    // a TO deciding whether to fill one in needs to tell them apart.
    expect(status).toEqual([
      ['Ada', 'Fox'],
      ['mudd', 'no main found'],
      ['Newcomer', 'looking…'],
    ]);
  });

  it('saves the character a TO picks', async () => {
    const onSave = renderPanel();

    fireEvent.change(screen.getByLabelText('Main for Newcomer'), { target: { value: '200' } });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(13, 200));
  });

  it('can clear a main rather than only replace it', async () => {
    // Clearing a wrong guess is its own action; leaving it in place because
    // the TO has nothing better to put there would keep mis-prefilling.
    const onSave = renderPanel();

    fireEvent.change(screen.getByLabelText('Main for Ada'), { target: { value: '' } });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(11, null));
  });

  it('shows a failed save instead of pretending it worked', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Database is down'));
    renderPanel(onSave);

    fireEvent.change(screen.getByLabelText('Main for Newcomer'), { target: { value: '100' } });

    // A TO who thinks they set a main and did not gets a wrong suggestion at
    // the worst possible moment.
    expect(await screen.findByText('Database is down')).toBeInTheDocument();
  });

  it('says so plainly when there is nobody to set a main for', () => {
    render(<MainsPanel sets={[]} characters={[FOX]} videogameId={1386} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText(/No players with sets left to play/)).toBeInTheDocument();
  });
});
