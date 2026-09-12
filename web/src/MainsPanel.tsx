import { useEffect, useMemo, useState } from 'react';
import type { Character, OpenSet } from './types';

interface Props {
  sets: OpenSet[];
  characters: Character[];
  videogameId: number;
  onClose: () => void;
  onSave: (playerId: number, characterId: number | null) => Promise<void>;
}

interface Player {
  playerId: number;
  name: string;
  /** Absent while the background lookup is still running for this player. */
  main?: { characterId: number | null; setsConsidered: number };
}

/**
 * Every distinct player with a set still to play, in name order.
 *
 * Drawn from the open-sets list because that is the only place a start.gg
 * *player* id reaches the client — bracket slots carry entrant ids, which are
 * per-event and cannot key a main that outlives the tournament.
 */
export function playersNeedingMains(sets: OpenSet[]): Player[] {
  const byPlayer = new Map<number, Player>();
  for (const set of sets) {
    for (const entrant of set.entrants) {
      if (entrant.playerId == null || byPlayer.has(entrant.playerId)) continue;
      byPlayer.set(entrant.playerId, {
        playerId: entrant.playerId,
        name: entrant.name,
        main: entrant.suggestedMain,
      });
    }
  }
  return [...byPlayer.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * Lets a TO set a player's main by hand.
 *
 * The automatic lookup reads a player's recent sets, which answers nothing for
 * someone new, someone who just switched, or an event where nobody reports
 * characters. A main set here is stored against the start.gg player rather than
 * the entrant, so it is still there at the next tournament — which is the point
 * of filling them in at all.
 */
export function MainsPanel({ sets, characters, videogameId, onClose, onSave }: Props) {
  const players = useMemo(() => playersNeedingMains(sets), [sets]);
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const [saving, setSaving] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  async function choose(player: Player, value: string) {
    setSaving(player.playerId);
    setFailed(null);
    try {
      await onSave(player.playerId, value === '' ? null : Number(value));
    } catch (err) {
      // Rendered, not swallowed: a TO who thinks they set a main and did not
      // gets a wrong suggestion at the worst moment.
      setFailed(err instanceof Error ? err.message : `Couldn't save ${player.name}'s main`);
    } finally {
      setSaving(null);
    }
  }

  function describe(player: Player): string {
    if (!player.main) return 'looking…';
    if (player.main.characterId === null) {
      return player.main.setsConsidered === 0 ? 'not set' : 'no main found';
    }
    return byId.get(player.main.characterId)?.name ?? 'unknown character';
  }

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal mains-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mains-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="help-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="help-modal-body">
          <h2 id="mains-modal-title">Player mains</h2>
          <p className="subtitle">
            Used to pre-fill the character when reporting. Saved against the player, so it carries to their next
            tournament.
          </p>

          {failed && <p className="error">{failed}</p>}

          {players.length === 0 ? (
            // Honest about the limit rather than looking broken: only players
            // with a set still to play reach the client with a player id.
            <p className="mains-empty">No players with sets left to play in this pool.</p>
          ) : (
            <ul className="mains-list">
              {players.map((player) => {
                const icon = player.main?.characterId != null ? byId.get(player.main.characterId)?.imageUrl : undefined;
                return (
                  <li key={player.playerId}>
                    {icon ? <img className="mains-icon" src={icon} alt="" /> : <span className="mains-icon" />}
                    <span className="mains-name">{player.name}</span>
                    <span className="mains-current">{describe(player)}</span>
                    <select
                      aria-label={`Main for ${player.name}`}
                      disabled={saving === player.playerId}
                      value={player.main?.characterId ?? ''}
                      onChange={(e) => choose(player, e.target.value)}
                    >
                      <option value="">— none —</option>
                      {characters.map((character) => (
                        <option key={character.id} value={character.id}>
                          {character.name}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}

          {videogameId === 0 && <p className="error">No game loaded, so mains can't be saved yet.</p>}
        </div>
      </div>
    </div>
  );
}
