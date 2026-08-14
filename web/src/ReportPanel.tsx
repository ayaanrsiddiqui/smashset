import { useEffect, useRef, useState } from 'react';
import type { Character, OpenSet, Stage } from './types';
import { parseScoreShorthand, parseQuickScore, quickScoreToShorthand, type ParsedGame } from './scoreParser';
import { BO_OPTIONS, boLabel, guessRequiredWins } from './roundFormat';
import { FuzzyCell } from './FuzzyCell';
import { reportSet, type StageSelection } from './api';
import { lookupMain } from './mains';

interface Props {
  set: OpenSet;
  presumedWinnerId: number | null;
  characters: Character[];
  stages: Stage[];
  onDone: () => void;
  onCancel: () => void;
}

type CharSide = 'winner' | 'loser';
type CharTarget = 'all' | number;

type Mode =
  | { kind: 'idle' }
  | { kind: 'confirmLeave' }
  | { kind: 'confirmSubmit' }
  | { kind: 'boInput' }
  | { kind: 'game' }
  | { kind: 'quick' }
  | { kind: 'stages'; game: number | null }
  | { kind: 'characters'; side: CharSide | null; target: CharTarget | null };

type CharsByGame = Record<number, { winner: Character | null; loser: Character | null }>;

export function ReportPanel({ set, presumedWinnerId, characters, stages, onDone, onCancel }: Props) {
  const [entrantA, entrantB] = set.entrants;
  const [winnerId, setWinnerId] = useState<number>(presumedWinnerId ?? entrantA.id);
  const [requiredWins, setRequiredWins] = useState(() => guessRequiredWins(set.fullRoundText));
  const [mode, setMode] = useState<Mode>({ kind: 'game' });
  const [scoreSource, setScoreSource] = useState<'detailed' | 'quick'>('detailed');
  const [shorthand, setShorthand] = useState('');
  const [quickRaw, setQuickRaw] = useState('');
  const [charsByGame, setCharsByGame] = useState<CharsByGame>({});
  const [stagesByGame, setStagesByGame] = useState<Record<number, Stage | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const shorthandRef = useRef<HTMLInputElement>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  const loser = winnerId === entrantA.id ? entrantB : entrantA;
  const winner = winnerId === entrantA.id ? entrantA : entrantB;

  useEffect(() => {
    if (mode.kind === 'game') shorthandRef.current?.focus();
    else if (mode.kind === 'quick') quickRef.current?.focus();
  }, [mode.kind]);

  let games: ParsedGame[] | null = null;
  let parseError: string | null = null;
  let submitRequiredWins = requiredWins;
  let submitShorthand = shorthand;
  const raw = scoreSource === 'quick' ? quickRaw : shorthand;
  if (raw.trim()) {
    try {
      if (scoreSource === 'quick') {
        const q = parseQuickScore(quickRaw);
        submitRequiredWins = q.winnerCount;
        submitShorthand = quickScoreToShorthand(q.winnerCount, q.loserCount);
        games = parseScoreShorthand(submitShorthand, submitRequiredWins);
      } else {
        games = parseScoreShorthand(shorthand, requiredWins);
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : 'Invalid score';
    }
  }

  const winnerGameCount = games?.filter((g) => g.winnerWonGame).length ?? 0;
  const loserGameCount = games ? games.length - winnerGameCount : 0;

  function flip() {
    const newWinnerId = loser.id;
    setCharsByGame((prev) => {
      const next: CharsByGame = {};
      for (const [g, v] of Object.entries(prev)) next[Number(g)] = { winner: v.loser, loser: v.winner };
      return next;
    });
    setWinnerId(newWinnerId);
  }

  function commitChar(side: CharSide, target: CharTarget, item: Character) {
    setCharsByGame((prev) => {
      const next: CharsByGame = { ...prev };
      const nums = target === 'all' ? (games ?? []).map((g) => g.gameNum) : [target];
      for (const g of nums) {
        const cur = next[g] ?? { winner: null, loser: null };
        next[g] = side === 'winner' ? { ...cur, winner: item } : { ...cur, loser: item };
      }
      return next;
    });
    setMode({ kind: 'characters', side, target: null });
  }

  function cancelCharTarget() {
    setMode((m) => (m.kind === 'characters' ? { kind: 'characters', side: m.side, target: null } : m));
  }

  function commitStage(gameNum: number, item: Stage) {
    setStagesByGame((prev) => ({ ...prev, [gameNum]: item }));
    setMode({ kind: 'stages', game: null });
  }

  function cancelStageTarget() {
    setMode((m) => (m.kind === 'stages' ? { kind: 'stages', game: null } : m));
  }

  function applyMains() {
    if (!games) return;
    const winnerMain = lookupMain(winner.name, characters);
    const loserMain = lookupMain(loser.name, characters);
    if (!winnerMain && !loserMain) return;
    setCharsByGame((prev) => {
      const next: CharsByGame = { ...prev };
      for (const g of games!.map((g) => g.gameNum)) {
        const cur = next[g] ?? { winner: null, loser: null };
        next[g] = {
          winner: winnerMain ?? cur.winner,
          loser: loserMain ?? cur.loser,
        };
      }
      return next;
    });
  }

  async function submit() {
    if (!games || games.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const charactersPayload = games
        .map((g) => ({
          gameNum: g.gameNum,
          winnerCharacterId: charsByGame[g.gameNum]?.winner?.id,
          loserCharacterId: charsByGame[g.gameNum]?.loser?.id,
        }))
        .filter((c) => c.winnerCharacterId != null || c.loserCharacterId != null);

      const stagesPayload = games
        .map((g) => ({ gameNum: g.gameNum, stageId: stagesByGame[g.gameNum]?.id }))
        .filter((s): s is StageSelection => s.stageId != null);

      await reportSet({
        setId: set.id,
        winnerEntrantId: winner.id,
        loserEntrantId: loser.id,
        requiredWins: submitRequiredWins,
        shorthand: submitShorthand,
        characters: charactersPayload.length > 0 ? charactersPayload : undefined,
        stages: stagesPayload.length > 0 ? stagesPayload : undefined,
      });
      onDone();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to report set');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

      if (e.key === 'Escape') {
        if (mode.kind === 'confirmLeave') {
          onCancel();
          return;
        }
        e.preventDefault();
        (active as HTMLElement | null)?.blur?.();
        if (mode.kind === 'idle') {
          setMode({ kind: 'confirmLeave' });
        } else if (mode.kind === 'confirmSubmit') {
          setMode({ kind: 'idle' });
        } else if (mode.kind === 'characters') {
          if (mode.side != null) setMode({ kind: 'characters', side: null, target: null });
          else setMode({ kind: 'idle' });
        } else if (mode.kind === 'stages') {
          setMode({ kind: 'idle' });
        } else {
          setMode({ kind: 'idle' });
        }
        return;
      }

      if (mode.kind === 'confirmSubmit') {
        if (e.key === 'Enter') {
          e.preventDefault();
          submit();
        }
        return;
      }

      if (mode.kind === 'confirmLeave') {
        e.preventDefault();
        setMode({ kind: 'idle' });
        return;
      }

      if (inField) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        setMode({ kind: 'confirmSubmit' });
        return;
      }

      if (mode.kind === 'characters' && mode.side == null) {
        if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          setMode({ kind: 'characters', side: 'winner', target: null });
          return;
        }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          setMode({ kind: 'characters', side: 'loser', target: null });
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          applyMains();
          return;
        }
      }

      if (mode.kind === 'characters' && mode.side != null && mode.target == null) {
        if (e.key === 'a' || e.key === 'A') {
          e.preventDefault();
          setMode({ kind: 'characters', side: mode.side, target: 'all' });
          return;
        }
        if (/^[1-9]$/.test(e.key) && games && Number(e.key) <= games.length) {
          e.preventDefault();
          setMode({ kind: 'characters', side: mode.side, target: Number(e.key) });
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          applyMains();
          return;
        }
      }

      if (mode.kind === 'stages' && mode.game == null) {
        if (/^[1-9]$/.test(e.key) && games && Number(e.key) <= games.length) {
          e.preventDefault();
          setMode({ kind: 'stages', game: Number(e.key) });
          return;
        }
      }

      if (mode.kind === 'boInput') {
        if (e.key === 'o' || e.key === 'O') {
          e.preventDefault();
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          e.preventDefault();
          const n = Number(e.key);
          if (n % 2 === 1) setRequiredWins((n + 1) / 2);
          setMode({ kind: 'idle' });
          return;
        }
        e.preventDefault();
        setMode({ kind: 'idle' });
        return;
      }

      switch (e.key) {
        case 'g':
        case 'G':
          e.preventDefault();
          setScoreSource('detailed');
          setMode({ kind: 'game' });
          return;
        case 'q':
        case 'Q':
          e.preventDefault();
          setScoreSource('quick');
          setMode({ kind: 'quick' });
          return;
        case 'c':
        case 'C':
          if (games) {
            e.preventDefault();
            setMode({ kind: 'characters', side: null, target: null });
          }
          return;
        case 's':
        case 'S':
          if (games) {
            e.preventDefault();
            setMode({ kind: 'stages', game: null });
          }
          return;
        case 'f':
        case 'F':
          e.preventDefault();
          flip();
          return;
        case 'b':
        case 'B':
          e.preventDefault();
          setMode({ kind: 'boInput' });
          return;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return (
    <div className="report-panel">
      {mode.kind === 'confirmLeave' ? (
        <div className="confirm-row leave-confirm">
          <button className="confirm-leave-btn" onClick={onCancel} aria-label="Leave without submitting">
            ←
          </button>
          <button onClick={() => setMode({ kind: 'idle' })}>stay</button>
        </div>
      ) : (
        <button className="back-link" onClick={() => setMode({ kind: 'confirmLeave' })}>
          ← back to search
        </button>
      )}

      <div className="round-label">
        {set.fullRoundText} · {set.identifier}
      </div>

      {set.isPreview && (
        <p className="error">
          This bracket hasn't been started on start.gg yet, so this is only a preview matchup — it can't be reported
          until the bracket is actually started.
        </p>
      )}

      <div className="matchup">
        <div className="side winner-side">
          <span className="side-name">{winner.name}</span>
          <span className="badge">winner</span>
        </div>
        <button className="flip-btn" onClick={flip} title="Flip winner (f)" aria-label="Flip winner">
          ⇄
        </button>
        <button className="side loser-side" onClick={flip}>
          <span className="side-name">{loser.name}</span>
        </button>
      </div>

      <div className={`bo-toggle ${mode.kind === 'boInput' ? 'focused' : ''}`}>
        {BO_OPTIONS.map((opt) => (
          <button
            key={opt.label}
            className={requiredWins === opt.requiredWins ? 'selected' : ''}
            onClick={() => setRequiredWins(opt.requiredWins)}
          >
            {opt.label}
          </button>
        ))}
        {!BO_OPTIONS.some((o) => o.requiredWins === requiredWins) && (
          <span className="bo-current">{boLabel(requiredWins)}</span>
        )}
        <span className="tool-hint">
          <kbd>b</kbd>/<kbd>bo</kbd> + odd number
        </span>
      </div>

      <div className="score-section">
        <div className={`score-tool ${mode.kind === 'game' ? 'focused' : ''}`}>
          <label htmlFor="shorthand">
            Game-by-game — <kbd>g</kbd>
          </label>
          <input
            id="shorthand"
            ref={shorthandRef}
            value={shorthand}
            onFocus={() => {
              setScoreSource('detailed');
              setMode({ kind: 'game' });
            }}
            onChange={(e) => {
              setScoreSource('detailed');
              setShorthand(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setMode({ kind: 'confirmSubmit' });
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                shorthandRef.current?.blur();
                setMode({ kind: 'idle' });
                return;
              }
              const append = (ch: string) => {
                e.preventDefault();
                setScoreSource('detailed');
                setShorthand((s) => s + ch);
              };
              if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') append('W');
              else if (e.key === 'l' || e.key === 'L' || e.key === 'ArrowDown' || e.key === 'ArrowRight') append('L');
            }}
            placeholder='"124", "-3", "WWLW", or arrow keys'
          />
        </div>

        <div className={`score-tool ${mode.kind === 'quick' ? 'focused' : ''}`}>
          <label htmlFor="quick-score">
            Quick score, no per-game detail — <kbd>q</kbd>
          </label>
          <input
            id="quick-score"
            ref={quickRef}
            value={quickRaw}
            onFocus={() => {
              setScoreSource('quick');
              setMode({ kind: 'quick' });
            }}
            onChange={(e) => {
              setScoreSource('quick');
              setQuickRaw(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setMode({ kind: 'confirmSubmit' });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                quickRef.current?.blur();
                setMode({ kind: 'idle' });
              }
            }}
            placeholder="3-1"
          />
        </div>

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
        <div className={`characters-section ${mode.kind === 'characters' ? 'focused' : ''}`}>
          <div className="tool-label">
            Characters — <kbd>c</kbd>, then <kbd>w</kbd>/<kbd>l</kbd>, then <kbd>a</kbd> or a game number ·{' '}
            <kbd>m</kbd> for mains
          </div>
          <div className="char-grid">
            <div className="char-grid-row header">
              <span className="row-label" />
              <span>{winner.name}</span>
              <span>{loser.name}</span>
            </div>
            <div className="char-grid-row">
              <span className="row-label">all</span>
              <FuzzyCell
                items={characters}
                value={null}
                emptyLabel="all games"
                placeholder="type a character…"
                active={mode.kind === 'characters' && mode.side === 'winner' && mode.target === 'all'}
                onCommit={(c) => commitChar('winner', 'all', c)}
                onCancel={cancelCharTarget}
                onFocusRequest={() => setMode({ kind: 'characters', side: 'winner', target: 'all' })}
              />
              <FuzzyCell
                items={characters}
                value={null}
                emptyLabel="all games"
                placeholder="type a character…"
                active={mode.kind === 'characters' && mode.side === 'loser' && mode.target === 'all'}
                onCommit={(c) => commitChar('loser', 'all', c)}
                onCancel={cancelCharTarget}
                onFocusRequest={() => setMode({ kind: 'characters', side: 'loser', target: 'all' })}
              />
            </div>
            {games.map((g) => (
              <div className="char-grid-row" key={g.gameNum}>
                <span className="row-label">G{g.gameNum}</span>
                <FuzzyCell
                  items={characters}
                  value={charsByGame[g.gameNum]?.winner ?? null}
                  placeholder="type a character…"
                  active={mode.kind === 'characters' && mode.side === 'winner' && mode.target === g.gameNum}
                  onCommit={(c) => commitChar('winner', g.gameNum, c)}
                  onCancel={cancelCharTarget}
                  onFocusRequest={() => setMode({ kind: 'characters', side: 'winner', target: g.gameNum })}
                />
                <FuzzyCell
                  items={characters}
                  value={charsByGame[g.gameNum]?.loser ?? null}
                  placeholder="type a character…"
                  active={mode.kind === 'characters' && mode.side === 'loser' && mode.target === g.gameNum}
                  onCommit={(c) => commitChar('loser', g.gameNum, c)}
                  onCancel={cancelCharTarget}
                  onFocusRequest={() => setMode({ kind: 'characters', side: 'loser', target: g.gameNum })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {games && !parseError && stages.length > 0 && (
        <div className={`stages-section ${mode.kind === 'stages' ? 'focused' : ''}`}>
          <div className="tool-label">
            Stages — <kbd>s</kbd>, then a game number
          </div>
          <div className="stage-grid">
            {games.map((g) => (
              <div className="stage-grid-row" key={g.gameNum}>
                <span className="row-label">G{g.gameNum}</span>
                <FuzzyCell
                  items={stages}
                  value={stagesByGame[g.gameNum] ?? null}
                  placeholder="type a stage…"
                  active={mode.kind === 'stages' && mode.game === g.gameNum}
                  onCommit={(s) => commitStage(g.gameNum, s)}
                  onCancel={cancelStageTarget}
                  onFocusRequest={() => setMode({ kind: 'stages', game: g.gameNum })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {mode.kind === 'confirmSubmit' ? (
        <div className="confirm-row submit-confirm">
          <button className="confirm-yes" onClick={submit} disabled={submitting} aria-label="Confirm report">
            ✓
          </button>
          <button className="confirm-no" onClick={() => setMode({ kind: 'idle' })} aria-label="Cancel">
            ✕
          </button>
        </div>
      ) : (
        <button
          className="submit-btn"
          disabled={!games || !!parseError || submitting || set.isPreview}
          onClick={() => setMode({ kind: 'confirmSubmit' })}
        >
          {submitting ? 'Reporting…' : 'Report set'}
        </button>
      )}
      {submitError && <p className="error">{submitError}</p>}
    </div>
  );
}
