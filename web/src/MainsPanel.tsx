import { useEffect, useMemo, useState } from 'react';
import { fetchPoolPlayers } from './api';
import type { Character, PoolPlayer } from './types';

interface Props {
  phaseGroupId: number;
  characters: Character[];
  onClose: () => void;
  onSave: (playerId: number, characterId: number | null) => Promise<void>;
}

/**
 * Lets a TO set a player's main by hand.
 *
 * The automatic lookup reads a player's recent sets, which answers nothing for
 * someone new, someone who just switched, or an event where nobody reports
 * characters. A main set here is stored against the start.gg player rather than
 * the entrant, so it is still there at their next tournament — which is the
 * point of filling them in at all.
 *
 * Loads the whole pool rather than reading the open-sets list already in
 * memory: mains are most useful filled in before anything starts, and a player
 * whose current set is finished still has later ones.
 */
export function MainsPanel({ phaseGroupId, characters, onClose, onSave }: Props) {
  const [players, setPlayers] = useState<PoolPlayer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);

  useEffect(() => {
    let cancelled = false;
    fetchPoolPlayers(phaseGroupId)
      .then((result) => {
        if (cancelled) return;
        setPlayers([...result.players].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load the players in this pool');
      });
    return () => {
      cancelled = true;
    };
  }, [phaseGroupId]);

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

  async function choose(player: PoolPlayer, value: string) {
    const characterId = value === '' ? null : Number(value);
    setSaving(player.playerId);
    setFailed(null);
    try {
      await onSave(player.playerId, characterId);
      setPlayers(
        (current) =>
          current?.map((p) =>
            p.playerId === player.playerId ? { ...p, main: { characterId, gamesTallied: 0, setsConsidered: 0 } } : p
          ) ?? null
      );
    } catch (err) {
      // Rendered, not swallowed: a TO who thinks they set a main and did not
      // gets a wrong suggestion at the worst moment.
      setFailed(err instanceof Error ? err.message : `Couldn't save ${player.name}'s main`);
    } finally {
      setSaving(null);
    }
  }

  /**
   * What this row can say that the dropdown beside it cannot.
   *
   * Null once a character is actually on file: the dropdown already shows its
   * name, and repeating it in the column alongside made every filled-in row
   * say the same thing twice. What is worth a word is the absence — "never
   * looked" and "looked and found nothing" are different facts, and a TO
   * deciding whether to fill one in needs to tell them apart. Opening this
   * panel starts a lookup for anyone missing one.
   */
  function noteFor(player: PoolPlayer): string | null {
    if (!player.main) return 'looking up…';
    if (player.main.characterId === null) {
      return player.main.setsConsidered === 0 ? 'not set' : 'no main found';
    }
    // On file, but not in this videogame's roster — worth saying, because the
    // dropdown cannot show a name it does not have.
    return byId.has(player.main.characterId) ? null : 'unknown character';
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
            Everyone in this pool. Used to pre-fill the character when reporting, and saved against the player, so it
            carries to their next tournament.
          </p>

          {loadError && <p className="error">{loadError}</p>}
          {failed && <p className="error">{failed}</p>}

          {!players && !loadError && <p className="mains-empty">Loading…</p>}
          {players?.length === 0 && <p className="mains-empty">No players seeded into this pool yet.</p>}

          {players && players.length > 0 && (
            <ul className="mains-list">
              {players.map((player) => {
                const icon = player.main?.characterId != null ? byId.get(player.main.characterId)?.imageUrl : undefined;
                const note = noteFor(player);
                return (
                  <li key={player.playerId}>
                    <span className="mains-name">{player.name}</span>
                    {note && <span className="mains-current">{note}</span>}
                    {/* The icon sits with the dropdown, which is where the
                        character it belongs to is named. */}
                    <span className="mains-pick">
                      {icon ? <img className="mains-icon" src={icon} alt="" /> : <span className="mains-icon" />}
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
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
