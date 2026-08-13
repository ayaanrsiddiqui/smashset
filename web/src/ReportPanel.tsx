import { useRef, useState } from 'react';
import type { Character, OpenSet } from './types';
import { parseScoreShorthand, type ParsedGame } from './scoreParser';
import { BO_OPTIONS, guessRequiredWins } from './roundFormat';
import { CharacterPicker } from './CharacterPicker';
import { reportSet } from './api';

interface Props {
  set: OpenSet;
  presumedWinnerId: number | null;
  characters: Character[];
  onDone: () => void;
  onCancel: () => void;
}

export function ReportPanel({ set, presumedWinnerId, characters, onDone, onCancel }: Props) {
  const [entrantA, entrantB] = set.entrants;
  const [winnerId, setWinnerId] = useState<number>(presumedWinnerId ?? entrantA.id);
  const [requiredWins, setRequiredWins] = useState(() => guessRequiredWins(set.fullRoundText));
  const [shorthand, setShorthand] = useState('');
  const [perGameMode, setPerGameMode] = useState(false);
  const [winnerChar, setWinnerChar] = useState<Character | null>(null);
  const [loserChar, setLoserChar] = useState<Character | null>(null);
  const [perGameChars, setPerGameChars] = useState<Record<number, { winner: Character | null; loser: Character | null }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const shorthandRef = useRef<HTMLInputElement>(null);

  const loser = winnerId === entrantA.id ? entrantB : entrantA;
  const winner = winnerId === entrantA.id ? entrantA : entrantB;

  let games: ParsedGame[] | null = null;
  let parseError: string | null = null;
  try {
    games = shorthand.trim() ? parseScoreShorthand(shorthand, requiredWins) : null;
  } catch (err) {
    parseError = err instanceof Error ? err.message : 'Invalid score';
  }

  const winnerGameCount = games?.filter((g) => g.winnerWonGame).length ?? 0;
  const loserGameCount = games ? games.length - winnerGameCount : 0;

  async function submit() {
    if (!games || games.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await reportSet({
        setId: set.id,
        winnerEntrantId: winner.id,
        loserEntrantId: loser.id,
        requiredWins,
        shorthand,
        characters:
          winnerChar || loserChar || perGameMode
            ? perGameMode
              ? {
                  mode: 'perGame',
                  perGame: games.map((g) => ({
                    gameNum: g.gameNum,
                    winnerCharacterId: perGameChars[g.gameNum]?.winner?.id,
                    loserCharacterId: perGameChars[g.gameNum]?.loser?.id,
                  })),
                }
              : {
                  mode: 'set',
                  winnerCharacterId: winnerChar?.id,
                  loserCharacterId: loserChar?.id,
                }
            : undefined,
      });
      onDone();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to report set');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="report-panel">
      <button className="back-link" onClick={onCancel}>
        ← back to search
      </button>

      <div className="round-label">
        {set.fullRoundText} · {set.identifier}
      </div>

      <div className="winner-select">
        {[entrantA, entrantB].map((e) => (
          <button
            key={e.id}
            className={`winner-btn ${winnerId === e.id ? 'selected' : ''}`}
            onClick={() => setWinnerId(e.id)}
          >
            {e.name}
            {winnerId === e.id && <span className="badge">winner</span>}
          </button>
        ))}
      </div>

      <div className="bo-toggle">
        {BO_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            className={requiredWins === opt.requiredWins ? 'selected' : ''}
            onClick={() => setRequiredWins(opt.requiredWins)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="shorthand-input">
        <label htmlFor="shorthand">
          Games {winner.name} won (e.g. "124"), or lost with "-" (e.g. "-3")
        </label>
        <input
          id="shorthand"
          ref={shorthandRef}
          autoFocus
          value={shorthand}
          onChange={(e) => setShorthand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && games && !parseError) submit();
          }}
          placeholder="124 or -3"
        />
        {parseError && <p className="error">{parseError}</p>}
        {games && !parseError && (
          <div className="score-preview">
            <span className="score-line">
              {winner.name} {winnerGameCount}–{loserGameCount} {loser.name}
            </span>
            <div className="game-chips">
              {games.map((g) => (
                <span key={g.gameNum} className={`chip ${g.winnerWonGame ? 'win' : 'loss'}`}>
                  G{g.gameNum}: {g.winnerWonGame ? winner.name : loser.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {games && !parseError && (
        <div className="character-section">
          {!perGameMode && (
            <div className="char-row">
              <CharacterPicker label={`${winner.name}'s character`} characters={characters} value={winnerChar} onChange={setWinnerChar} />
              <CharacterPicker label={`${loser.name}'s character`} characters={characters} value={loserChar} onChange={setLoserChar} />
            </div>
          )}
          {perGameMode && (
            <div className="char-per-game">
              {games.map((g) => (
                <div className="char-row" key={g.gameNum}>
                  <span className="game-num">G{g.gameNum}</span>
                  <CharacterPicker
                    label={`${winner.name}`}
                    characters={characters}
                    value={perGameChars[g.gameNum]?.winner ?? null}
                    onChange={(c) =>
                      setPerGameChars((prev) => ({ ...prev, [g.gameNum]: { winner: c, loser: prev[g.gameNum]?.loser ?? null } }))
                    }
                  />
                  <CharacterPicker
                    label={`${loser.name}`}
                    characters={characters}
                    value={perGameChars[g.gameNum]?.loser ?? null}
                    onChange={(c) =>
                      setPerGameChars((prev) => ({ ...prev, [g.gameNum]: { winner: prev[g.gameNum]?.winner ?? null, loser: c } }))
                    }
                  />
                </div>
              ))}
            </div>
          )}
          <label className="per-game-toggle">
            <input type="checkbox" checked={perGameMode} onChange={(e) => setPerGameMode(e.target.checked)} />
            Character changed mid-set
          </label>
        </div>
      )}

      <button className="submit-btn" disabled={!games || !!parseError || submitting} onClick={submit}>
        {submitting ? 'Reporting…' : 'Report set'}
      </button>
      {submitError && <p className="error">{submitError}</p>}
    </div>
  );
}
