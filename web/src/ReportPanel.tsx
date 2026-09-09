import { useEffect, useRef, useState } from 'react';
import type { Character, EntrantInfo, OpenSet, Stage } from './types';
import {
  parseScoreShorthand,
  previewGames,
  parseQuickScore,
  quickScoreToShorthand,
  type ParsedGame,
} from './scoreParser';
import { BO_OPTIONS, boLabel, guessRequiredWins } from './roundFormat';
import { FuzzyCell } from './FuzzyCell';
import { fuzzyMatchCharacters } from './characterAliases';
import { StageToggle } from './StageToggle';
import { reportSet, type StageSelection } from './api';
import { lookupMain } from './mains';

interface Props {
  set: OpenSet;
  presumedWinnerId: number | null;
  characters: Character[];
  stages: Stage[];
  topXBo5: number | null;
  onDone: () => void;
  onCancel: () => void;
}

type CharSide = 'winner' | 'loser';
type CharTarget = 'all' | number[];

type Mode =
  | { kind: 'game' }
  | { kind: 'confirmLeave' }
  | { kind: 'confirmSubmit' }
  | { kind: 'boInput' }
  | { kind: 'quick' }
  | { kind: 'stages'; game: number | null }
  | { kind: 'characters'; side: CharSide | null; target: CharTarget | null };

type CharsByGame = Record<number, { winner: Character | null; loser: Character | null }>;

export function ReportPanel({ set, presumedWinnerId, characters, stages, topXBo5, onDone, onCancel }: Props) {
  const [entrantA, entrantB] = set.entrants;
  const [winnerId, setWinnerId] = useState<number>(presumedWinnerId ?? entrantA.id);
  const [requiredWins, setRequiredWins] = useState(() =>
    guessRequiredWins(set.fullRoundText, set.lPlacement, topXBo5)
  );
  const [mode, setMode] = useState<Mode>({ kind: 'game' });
  const [scoreSource, setScoreSource] = useState<'detailed' | 'quick'>('detailed');
  const [shorthand, setShorthand] = useState('');
  const [resetShorthandNext, setResetShorthandNext] = useState(false);
  const [quickRaw, setQuickRaw] = useState('');
  const [charsByGame, setCharsByGame] = useState<CharsByGame>({});
  const [stagesByGame, setStagesByGame] = useState<Record<number, Stage | null>>({});
  // The last character applied to "every game" via the all-games box or m
  // (mains), per side — kept separate from charsByGame so that increasing
  // the game count later (e.g. bo3 -> bo5) can back-fill the newly-added
  // rows with it instead of leaving them empty.
  const [allGamesChar, setAllGamesChar] = useState<{ winner: Character | null; loser: Character | null }>({
    winner: null,
    loser: null,
  });
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Mirrors `submitting` but as a ref, not state: state updates aren't
  // applied until the next render, so keys dispatched faster than that
  // (mashing Enter with no gap) all see the same stale `submitting=false`
  // closure and all pass the guard. A ref mutates synchronously, so the
  // very next line of JS — even from an event fired a microtask later —
  // sees the flip. `submitting` itself stays purely for rendering.
  const submittingRef = useRef(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const confirmLeaveRef = useRef<HTMLDivElement>(null);
  const confirmSubmitRef = useRef<HTMLDivElement>(null);

  const loser = winnerId === entrantA.id ? entrantB : entrantA;
  const winner = winnerId === entrantA.id ? entrantA : entrantB;

  useEffect(() => {
    if (mode.kind === 'quick') quickRef.current?.focus();
  }, [mode.kind]);

  useEffect(() => {
    if (mode.kind === 'confirmLeave') confirmLeaveRef.current?.scrollIntoView({ block: 'nearest' });
    if (mode.kind === 'confirmSubmit') confirmSubmitRef.current?.scrollIntoView({ block: 'nearest' });
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

  // Lenient live view of the same buffer — unlike `games`/`parseError` above
  // (used for validation + submission), this never throws, so a mid-type
  // buffer like "wwl" still lights up the games it already describes instead
  // of the whole display going blank until the sequence is "finished".
  const displayGames = scoreSource === 'quick' ? (games ?? []) : previewGames(shorthand, requiredWins);
  const winnerGameCount = displayGames.filter((g) => g.winnerWonGame).length;
  const loserGameCount = displayGames.length - winnerGameCount;
  const showError = parseError != null && displayGames.length === 0;

  const effectiveRequiredWins = scoreSource === 'quick' && games ? submitRequiredWins : requiredWins;
  const maxRows = Math.max(requiredWins * 2 - 1, displayGames.length);
  const clinchedAt = displayGames.length > 0 && winnerGameCount >= effectiveRequiredWins ? displayGames.length : null;
  const isRowUsable = (n: number) => clinchedAt == null || n <= clinchedAt;

  // Back-fills newly-added rows (e.g. from a bo3 -> bo5 change) with
  // whichever character was last applied to "every game", so expanding the
  // set doesn't leave the new games empty. Only touches rows that didn't
  // exist before this render — a row a TO already overrode by hand stays
  // untouched even if it falls behind the sticky value.
  const prevMaxRowsRef = useRef(maxRows);
  useEffect(() => {
    const prevMax = prevMaxRowsRef.current;
    if (maxRows > prevMax && (allGamesChar.winner || allGamesChar.loser)) {
      setCharsByGame((prev) => {
        const next: CharsByGame = { ...prev };
        for (let g = prevMax + 1; g <= maxRows; g++) {
          const cur = next[g] ?? { winner: null, loser: null };
          next[g] = {
            winner: allGamesChar.winner ?? cur.winner,
            loser: allGamesChar.loser ?? cur.loser,
          };
        }
        return next;
      });
    }
    prevMaxRowsRef.current = maxRows;
  }, [maxRows, allGamesChar]);

  // Directly sets one game's result (row click, or w/l/arrow keys while that
  // row is focused) instead of appending to the typed shorthand buffer. Only
  // allowed for a game that's already reported (to correct it) or the very
  // next one in sequence — a gap in the middle can't be expressed as a valid
  // shorthand string, so anything further ahead is silently rejected, same
  // as any other invalid keystroke in this component.
  function setGameResult(n: number, winnerWon: boolean) {
    if (n < 1 || n > displayGames.length + 1) return;
    const length = Math.max(n, displayGames.length);
    let letters = '';
    for (let i = 1; i <= length; i++) {
      if (i === n) {
        letters += winnerWon ? 'W' : 'L';
        continue;
      }
      const existing = displayGames.find((dg) => dg.gameNum === i);
      if (!existing) return;
      letters += existing.winnerWonGame ? 'W' : 'L';
    }
    if (previewGames(letters, requiredWins).length === 0) return;
    setScoreSource('detailed');
    setShorthand(letters);
    setFocusedRow(n);
  }

  // Games, characters, and stages are all anchored to the winner/loser
  // slots, not to a specific person — so flipping who's currently sitting
  // in the winner slot re-points every one of them at the other player by
  // design. It must only change winnerId; dragging characters along with
  // the old winner would silently reattribute a pick to the wrong person.
  function flip() {
    setWinnerId(loser.id);
  }

  function commitChar(side: CharSide, target: CharTarget, item: Character) {
    // "all" fills up to maxRows, not just the games parsed so far — the
    // score doesn't have to be typed first for this to actually do
    // something. Any rows beyond the eventual real score are simply never
    // rendered or submitted, so over-filling here is harmless.
    const nums = target === 'all' ? Array.from({ length: maxRows }, (_, i) => i + 1) : target;
    const updated: CharsByGame = { ...charsByGame };
    for (const g of nums) {
      const cur = updated[g] ?? { winner: null, loser: null };
      updated[g] = side === 'winner' ? { ...cur, winner: item } : { ...cur, loser: item };
    }
    setCharsByGame(updated);
    if (target === 'all') {
      setAllGamesChar((prev) => ({ ...prev, [side]: item }));
    }

    // Move on to the next game that still needs this side's character,
    // rather than dropping back to "all" — landing on "all" reactivates and
    // refocuses that cell, reopening its dropdown right over the rows you
    // just filled in. Scans forward from the last game just filled, wrapping
    // around; if nothing's left empty (every row already has this side
    // filled in), there's nowhere useful to advance to, so target goes to
    // null — side stays selected (w/l/m still make sense) but no cell is
    // active, so nothing grabs focus or pops a dropdown unprompted.
    const anchor = target === 'all' ? maxRows : Math.max(...target);
    let nextTarget: CharTarget | null = null;
    for (let offset = 1; offset <= maxRows; offset++) {
      const g = ((anchor - 1 + offset) % maxRows) + 1;
      if (!isRowUsable(g)) continue;
      if (!updated[g]?.[side]) {
        nextTarget = [g];
        break;
      }
    }
    setMode({ kind: 'characters', side, target: nextTarget });
  }

  function cancelCharTarget() {
    // Back out to side:null (not just target:'all') — target:'all' would
    // instantly re-activate the all-games cell, since that's what "active"
    // means for it now, leaving no reachable non-active state to press
    // w/l/m from (those can't be intercepted mid-type without breaking
    // typing character names that contain those letters).
    setMode({ kind: 'characters', side: null, target: null });
  }

  // Shared by the global keydown handler (digits pressed with no cell
  // focused) and each character FuzzyCell's onGameDigit (digits pressed
  // while one of them has real DOM focus). Picking a side starts on "all
  // games"; the first digit switches away to just that game, further digits
  // toggle games in/out of the selection — so "1 3" targets games 1 and 3
  // together — falling back to "all" if toggling off would empty it.
  function toggleCharTarget(side: CharSide, n: number) {
    if (n < 1 || n > maxRows || !isRowUsable(n)) return;
    setMode((m) => {
      if (m.kind !== 'characters' || m.side !== side) return m;
      const current = m.target;
      const nextArr =
        current == null || current === 'all'
          ? [n]
          : current.includes(n)
            ? current.filter((g) => g !== n)
            : [...current, n];
      return { kind: 'characters', side, target: nextArr.length > 0 ? nextArr : 'all' };
    });
  }

  function commitStage(gameNum: number, item: Stage) {
    setStagesByGame((prev) => ({ ...prev, [gameNum]: item }));
    setMode({ kind: 'stages', game: null });
  }

  function cancelStageTarget() {
    setMode((m) => (m.kind === 'stages' ? { kind: 'stages', game: null } : m));
  }

  // Prefers the auto-computed suggestion (from the entrant's own recent
  // start.gg history) over the old hardcoded web/src/mains.ts lookup, which
  // stays as a manual-override fallback for players with no computable main
  // yet (e.g. too new to have 10 sets on record).
  function resolveMain(entrant: EntrantInfo): Character | null {
    const suggested =
      entrant.suggestedMainCharacterId != null
        ? (characters.find((c) => c.id === entrant.suggestedMainCharacterId) ?? null)
        : null;
    return suggested ?? lookupMain(entrant.name, characters);
  }

  function applyMains() {
    const winnerMain = resolveMain(winner);
    const loserMain = resolveMain(loser);
    if (!winnerMain && !loserMain) return;
    setCharsByGame((prev) => {
      const next: CharsByGame = { ...prev };
      for (let g = 1; g <= maxRows; g++) {
        const cur = next[g] ?? { winner: null, loser: null };
        next[g] = {
          winner: winnerMain ?? cur.winner,
          loser: loserMain ?? cur.loser,
        };
      }
      return next;
    });
    setAllGamesChar((prev) => ({
      winner: winnerMain ?? prev.winner,
      loser: loserMain ?? prev.loser,
    }));
  }

  async function submit() {
    if (submittingRef.current) return;
    if (!games || games.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Quick-reported scores are winner + overall score only — never drag in
      // character/stage picks left over from switching out of detailed entry
      // partway through. start.gg's reportBracketSet mutation always needs a
      // per-game gameData array to encode the score itself (there's no
      // separate "just a score" mutation), but each entry stays bare
      // ({gameNum, winnerId}) as long as characters/stages are omitted here.
      const charactersPayload =
        scoreSource === 'quick'
          ? []
          : games
              .map((g) => ({
                gameNum: g.gameNum,
                winnerCharacterId: charsByGame[g.gameNum]?.winner?.id,
                loserCharacterId: charsByGame[g.gameNum]?.loser?.id,
              }))
              .filter((c) => c.winnerCharacterId != null || c.loserCharacterId != null);

      const stagesPayload =
        scoreSource === 'quick'
          ? []
          : games
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
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // A report is already in flight — ignore everything, Escape included:
      // it's on its way to start.gg, so backing out of the panel now would
      // just hide it, not stop it. Reads the ref (not `submitting` state)
      // for the same reason `submit()` does — see its declaration.
      if (submittingRef.current) {
        e.preventDefault();
        return;
      }

      const active = document.activeElement;
      const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

      if (e.key === 'Escape') {
        if (mode.kind === 'confirmLeave') {
          onCancel();
          return;
        }
        e.preventDefault();
        (active as HTMLElement | null)?.blur?.();
        if (mode.kind === 'game') {
          if (focusedRow != null) setFocusedRow(null);
          else setMode({ kind: 'confirmLeave' });
        } else if (mode.kind === 'confirmSubmit') {
          setMode({ kind: 'game' });
        } else if (mode.kind === 'characters') {
          if (mode.side != null) setMode({ kind: 'characters', side: null, target: null });
          else setMode({ kind: 'game' });
        } else if (mode.kind === 'stages') {
          setMode({ kind: 'game' });
        } else {
          setMode({ kind: 'game' });
        }
        return;
      }

      if (mode.kind === 'confirmSubmit') {
        e.preventDefault();
        if (e.key === 'Enter') {
          submit();
        } else {
          setMode({ kind: 'game' });
        }
        return;
      }

      if (mode.kind === 'confirmLeave') {
        e.preventDefault();
        setMode({ kind: 'game' });
        return;
      }

      if (inField) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        setMode({ kind: 'confirmSubmit' });
        return;
      }

      if (mode.kind === 'game') {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFocusedRow((r) => (r == null ? 1 : Math.max(r - 1, 1)));
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFocusedRow((r) => (r == null ? 1 : Math.min(r + 1, maxRows)));
          return;
        }
        const appendToShorthand = (ch: string) => {
          const next = (resetShorthandNext ? '' : shorthand) + ch;
          if (previewGames(next, requiredWins).length === 0) return;
          setScoreSource('detailed');
          setShorthand(next);
          if (resetShorthandNext) setResetShorthandNext(false);
        };
        if (e.key === 'Backspace') {
          e.preventDefault();
          setScoreSource('detailed');
          if (resetShorthandNext) {
            setResetShorthandNext(false);
            setShorthand('');
          } else {
            setShorthand((s) => s.slice(0, -1));
          }
          return;
        }
        if (/^[0-9+-]$/.test(e.key)) {
          e.preventDefault();
          appendToShorthand(e.key);
          return;
        }
        if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowLeft') {
          e.preventDefault();
          if (focusedRow != null) setGameResult(focusedRow, true);
          else appendToShorthand('W');
          return;
        }
        if (e.key === 'l' || e.key === 'L' || e.key === 'ArrowRight') {
          e.preventDefault();
          if (focusedRow != null) setGameResult(focusedRow, false);
          else appendToShorthand('L');
          return;
        }
      }

      if (mode.kind === 'characters') {
        if (e.key === 'w' || e.key === 'W') {
          e.preventDefault();
          setMode({ kind: 'characters', side: 'winner', target: 'all' });
          return;
        }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          setMode({ kind: 'characters', side: 'loser', target: 'all' });
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          applyMains();
          return;
        }
        if (mode.side != null) {
          if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            setMode({ kind: 'characters', side: mode.side, target: 'all' });
            return;
          }
          if (/^[1-9]$/.test(e.key) && Number(e.key) <= maxRows && isRowUsable(Number(e.key))) {
            e.preventDefault();
            toggleCharTarget(mode.side, Number(e.key));
            return;
          }
        }
      }

      if (mode.kind === 'stages' && mode.game == null) {
        if (/^[1-9]$/.test(e.key) && Number(e.key) <= maxRows && isRowUsable(Number(e.key))) {
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
          setMode({ kind: 'game' });
          return;
        }
        e.preventDefault();
        setMode({ kind: 'game' });
        return;
      }

      switch (e.key) {
        case 'g':
        case 'G':
          e.preventDefault();
          setScoreSource('detailed');
          setResetShorthandNext(true);
          setFocusedRow(null);
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
          e.preventDefault();
          setMode({ kind: 'characters', side: null, target: null });
          return;
        case 's':
        case 'S':
          e.preventDefault();
          setMode({ kind: 'stages', game: null });
          return;
        case 'f':
        case 'F':
          e.preventDefault();
          flip();
          return;
        case 'm':
        case 'M':
          e.preventDefault();
          applyMains();
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

  const rowNumbers = Array.from({ length: maxRows }, (_, i) => i + 1);

  // When multiple games are targeted (e.g. "1 3"), only the most-recently
  // toggled one gets the real active input — the rest just show a queued
  // outline — so there's never more than one text box fighting for focus.
  // Whichever one is active still applies its pick to the whole selection.
  const charSide = mode.kind === 'characters' ? mode.side : null;
  const charTargetArr: number[] | null =
    mode.kind === 'characters' && mode.target != null && mode.target !== 'all' ? mode.target : null;
  const charPending = mode.kind === 'characters' && mode.side === null;

  return (
    <div className="report-panel">
      {mode.kind === 'confirmLeave' ? (
        <div className="confirm-row leave-confirm" ref={confirmLeaveRef}>
          <button className="confirm-leave-btn" onClick={onCancel} aria-label="Leave without submitting">
            ←
          </button>
          <button onClick={() => setMode({ kind: 'game' })}>stay</button>
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

      <div className="sticky-header">
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
      </div>

      <div className="score-section">
        {mode.kind === 'quick' && (
          <div className="score-tool focused">
            <label htmlFor="quick-score">
              Quick score, no per-game detail — <kbd>q</kbd>
            </label>
            <input
              id="quick-score"
              ref={quickRef}
              value={quickRaw}
              onChange={(e) => {
                setScoreSource('quick');
                setQuickRaw(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.stopPropagation();
                  setMode({ kind: 'confirmSubmit' });
                } else if (e.key === 'Escape' || e.key === 'q' || e.key === 'Q') {
                  // q toggles back to the main display, same as Escape —
                  // it's a plain character otherwise, so it'd just get typed
                  // into the box instead of ever reaching here without this.
                  e.preventDefault();
                  e.stopPropagation();
                  quickRef.current?.blur();
                  setMode({ kind: 'game' });
                }
              }}
              placeholder="3-1"
            />
          </div>
        )}

        {showError && <p className="error">{parseError}</p>}
        {mode.kind !== 'quick' && (
          <div className="score-preview">
            <span className="score-line">
              {winner.name} {winnerGameCount}–{loserGameCount} {loser.name}
            </span>
          </div>
        )}
      </div>

      {mode.kind !== 'quick' && (
        <div
          className={`game-stats-section ${
            mode.kind === 'game' || mode.kind === 'characters' || mode.kind === 'stages' ? 'focused' : ''
          } ${charPending ? 'char-pending' : ''}`}
        >
          <div className="game-stat-row all-games-row">
          <div className="game-stat-title">All games</div>
          <div className="game-stat-sides">
            <div className="game-stat-side">
              <div className="game-stat-char">
                <FuzzyCell
                  items={characters}
                  matchItems={fuzzyMatchCharacters}
                  value={null}
                  emptyLabel="all games"
                  placeholder="type a character…"
                  reverse
                  active={mode.kind === 'characters' && mode.side === 'winner' && mode.target === 'all'}
                  onCommit={(c) => commitChar('winner', 'all', c)}
                  onCancel={cancelCharTarget}
                  onFocusRequest={() => setMode({ kind: 'characters', side: 'winner', target: 'all' })}
                  onGameDigit={(digit) => toggleCharTarget('winner', digit)}
                />
              </div>
            </div>
            <div className="game-stat-mid invisible" aria-hidden="true">
              <span className="game-stat-arrow-btn left">←</span>
              <span className="game-stat-arrow-btn right">→</span>
            </div>
            <div className="game-stat-side">
              <div className="game-stat-char">
                <FuzzyCell
                  items={characters}
                  matchItems={fuzzyMatchCharacters}
                  value={null}
                  emptyLabel="all games"
                  placeholder="type a character…"
                  active={mode.kind === 'characters' && mode.side === 'loser' && mode.target === 'all'}
                  onCommit={(c) => commitChar('loser', 'all', c)}
                  onCancel={cancelCharTarget}
                  onFocusRequest={() => setMode({ kind: 'characters', side: 'loser', target: 'all' })}
                  onGameDigit={(digit) => toggleCharTarget('loser', digit)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="game-stat-list">
          {rowNumbers.map((n) => {
            const g = displayGames.find((dg) => dg.gameNum === n);
            const usable = isRowUsable(n);
            const rowFocused = mode.kind === 'game' && focusedRow === n;
            const winnerCellActive =
              charSide === 'winner' && charTargetArr != null && charTargetArr[charTargetArr.length - 1] === n;
            const winnerCellMulti =
              charSide === 'winner' && charTargetArr != null && charTargetArr.length > 1 && charTargetArr.includes(n);
            const loserCellActive =
              charSide === 'loser' && charTargetArr != null && charTargetArr[charTargetArr.length - 1] === n;
            const loserCellMulti =
              charSide === 'loser' && charTargetArr != null && charTargetArr.length > 1 && charTargetArr.includes(n);
            return (
              <div
                className={`game-stat-row ${usable ? 'clickable' : 'unused'} ${rowFocused ? 'row-focused' : ''}`}
                key={n}
                onClick={
                  usable
                    ? () => {
                        setFocusedRow(n);
                        setMode({ kind: 'game' });
                      }
                    : undefined
                }
              >
                <div className="game-stat-title">Game {n}</div>
                <div className="game-stat-sides">
                  <div className={`game-stat-side ${g?.winnerWonGame ? 'won' : ''}`}>
                    <div className="game-stat-char">
                      {usable ? (
                        <FuzzyCell
                          items={characters}
                          matchItems={fuzzyMatchCharacters}
                          value={charsByGame[n]?.winner ?? null}
                          placeholder="type a character…"
                          reverse
                          active={winnerCellActive}
                          multiSelect={winnerCellMulti}
                          onCommit={(c) => commitChar('winner', charTargetArr ?? [n], c)}
                          onCancel={cancelCharTarget}
                          onFocusRequest={() => setMode({ kind: 'characters', side: 'winner', target: [n] })}
                          onGameDigit={(digit) => toggleCharTarget('winner', digit)}
                        />
                      ) : (
                        <span className="fuzzy-cell empty">—</span>
                      )}
                    </div>
                  </div>
                  {usable ? (
                    <div className="game-stat-mid">
                      <button
                        type="button"
                        className={`game-stat-arrow-btn left ${g?.winnerWonGame ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setGameResult(n, true);
                        }}
                        aria-label={`Game ${n}: ${winner.name} won`}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        className={`game-stat-arrow-btn right ${g && !g.winnerWonGame ? 'active' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setGameResult(n, false);
                        }}
                        aria-label={`Game ${n}: ${loser.name} won`}
                      >
                        →
                      </button>
                    </div>
                  ) : (
                    <div className="game-stat-mid invisible" aria-hidden="true">
                      <span className="game-stat-arrow-btn left">←</span>
                      <span className="game-stat-arrow-btn right">→</span>
                    </div>
                  )}
                  <div className={`game-stat-side ${g && !g.winnerWonGame ? 'won' : ''}`}>
                    <div className="game-stat-char">
                      {usable ? (
                        <FuzzyCell
                          items={characters}
                          matchItems={fuzzyMatchCharacters}
                          value={charsByGame[n]?.loser ?? null}
                          placeholder="type a character…"
                          active={loserCellActive}
                          multiSelect={loserCellMulti}
                          onCommit={(c) => commitChar('loser', charTargetArr ?? [n], c)}
                          onCancel={cancelCharTarget}
                          onFocusRequest={() => setMode({ kind: 'characters', side: 'loser', target: [n] })}
                          onGameDigit={(digit) => toggleCharTarget('loser', digit)}
                        />
                      ) : (
                        <span className="fuzzy-cell empty">—</span>
                      )}
                    </div>
                  </div>
                </div>
                {stages.length > 0 && usable && (
                  <div className="game-stat-footer">
                    <StageToggle
                      stages={stages}
                      value={stagesByGame[n] ?? null}
                      active={mode.kind === 'stages' && mode.game === n}
                      onCommit={(s) => commitStage(n, s)}
                      onCancel={cancelStageTarget}
                      onFocusRequest={() => setMode({ kind: 'stages', game: n })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </div>
      )}

      {mode.kind === 'confirmSubmit' ? (
        <div className="confirm-row submit-confirm" ref={confirmSubmitRef}>
          <button
            className="confirm-yes"
            onClick={submit}
            disabled={submitting}
            aria-label={submitting ? 'Reporting…' : 'Confirm report'}
          >
            {submitting ? '…' : '✓'}
          </button>
          <button
            className="confirm-no"
            onClick={() => setMode({ kind: 'game' })}
            disabled={submitting}
            aria-label="Cancel"
          >
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

      <div className="sticky-footer">
        <div className="tool-label">
          <div>
            Score — digits (124, -3, +sweep), <kbd>w</kbd>/<kbd>l</kbd>, or <kbd>←</kbd>/<kbd>→</kbd> ·{' '}
            <kbd>↑</kbd>/<kbd>↓</kbd> or click to pick a game · <kbd>g</kbd> to refocus · <kbd>q</kbd> for quick set
            count
          </div>
          <div>
            Characters — <kbd>c</kbd>, then <kbd>w</kbd>/<kbd>l</kbd> (starts on all games), then numbers to target
            games (stack multiple) or <kbd>a</kbd> for all · <kbd>m</kbd> fills in mains anytime
          </div>
          {stages.length > 0 && (
            <div>
              Stage — <kbd>s</kbd>, then a game number
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
