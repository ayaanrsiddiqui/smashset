import { useEffect, useRef, useState } from 'react';
import type { Character, EntrantInfo, OpenSet, PriorResult, SetDetail, Stage, ToastKind } from './types';
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
import { ApiError, reportSet, updatePlayerMain, type ReportPayload, type StageSelection } from './api';
import { lookupMain } from './mains';
import { derivePriorState } from './priorDetail';

interface Props {
  set: OpenSet;
  presumedWinnerId: number | null;
  // Both present together when re-opening an already-completed set to
  // correct it — priorResult drives the "already reported" banner,
  // priorDetail (when start.gg actually has per-game records for this set)
  // additionally pre-fills the score/characters/stages below instead of
  // leaving them blank. Both null/absent for a normal not-yet-reported set.
  priorResult?: PriorResult | null;
  priorDetail?: SetDetail | null;
  // Who start.gg had as the winner when this set was opened, or null for one
  // nobody has reported. Only used to decide whether this report needs the
  // destructive confirmation below — the server checks for real, and refuses
  // if this was stale.
  priorWinnerEntrantId?: number | null;
  characters: Character[];
  stages: Stage[];
  topXBo5: number | null;
  videogameId: number;
  /** The pool being viewed, passed through so a report can wake its watchers. */
  phaseGroupId: number | null;
  // Hands the finished report to the outbox. Returns control immediately —
  // the panel closes and delivery happens behind the TO, who is already at the
  // next table. It is NOT a claim that anything was reported.
  onQueue: (payload: ReportPayload, label: string) => void;
  onNotify: (message: string, kind?: ToastKind) => void;
  // Returns true when the error was a dead session and has been handled by
  // ending it — the panel then stays quiet rather than toasting "Not signed
  // in" at a TO who is already being returned to the sign-in screen.
  onAuthError: (err: unknown) => boolean;
  onDone: () => void;
  onCancel: () => void;
}

type CharSide = 'winner' | 'loser';
type CharTarget = 'all' | number[];

type Mode =
  | { kind: 'game' }
  | { kind: 'confirmLeave' }
  | { kind: 'confirmSubmit' }
  // Reached only by the server refusing a winner change: start.gg cannot edit
  // one in place, so the result has to be torn down and everything downstream
  // goes with it. wouldClear is null when start.gg would not say what that is,
  // which must not read as "nothing".
  | { kind: 'confirmReset'; wouldClear: string[] | null }
  | { kind: 'boInput' }
  | { kind: 'quick' }
  | { kind: 'stages'; game: number | null }
  | { kind: 'characters'; side: CharSide | null; target: CharTarget | null }
  // Corrects a player's stored main (server/src/db/mains.ts), not this game's
  // pick — a longer-lived fix that carries forward to every future set this
  // player is in, separate from the per-game charsByGame state below.
  | { kind: 'editMain'; side: CharSide };

type CharsByGame = Record<number, { winner: Character | null; loser: Character | null }>;

// What's currently known about a player's main and how much to trust it —
// see mainStatus() below for how each variant gets decided.
type MainStatus =
  | { kind: 'none' }
  | { kind: 'manual'; character: Character | null }
  | { kind: 'suggested'; character: Character | null; gamesTallied: number; setsConsidered: number }
  | { kind: 'fallback'; character: Character };

export function ReportPanel({
  set,
  presumedWinnerId,
  priorResult,
  priorDetail,
  priorWinnerEntrantId = null,
  characters,
  stages,
  topXBo5,
  videogameId,
  phaseGroupId,
  onQueue,
  onNotify,
  onAuthError,
  onDone,
  onCancel,
}: Props) {
  const [entrantA, entrantB] = set.entrants;
  const [winnerId, setWinnerId] = useState<number>(presumedWinnerId ?? entrantA.id);
  // Derived once, from props alone (not state) — cheap enough to recompute
  // every render, and only its value at mount time actually matters: it
  // exists purely to seed the several useState calls below, which (by
  // design) only ever consult their initializer on the very first render.
  const derivedPrior = priorDetail
    ? derivePriorState(priorDetail, winnerId, winnerId === entrantA.id ? entrantB.id : entrantA.id, characters, stages)
    : null;
  const [requiredWins, setRequiredWins] = useState(() =>
    derivedPrior ? derivedPrior.requiredWins : guessRequiredWins(set.fullRoundText, set.lPlacement, topXBo5)
  );
  const [mode, setMode] = useState<Mode>({ kind: 'game' });
  const [scoreSource, setScoreSource] = useState<'detailed' | 'quick'>('detailed');
  const [shorthand, setShorthand] = useState(() => derivedPrior?.shorthand ?? '');
  const [resetShorthandNext, setResetShorthandNext] = useState(false);
  const [quickRaw, setQuickRaw] = useState('');
  const [charsByGame, setCharsByGame] = useState<CharsByGame>(() => derivedPrior?.charsByGame ?? {});
  const [stagesByGame, setStagesByGame] = useState<Record<number, Stage | null>>(() => derivedPrior?.stagesByGame ?? {});
  // The last character applied to "every game" via the all-games box or m
  // (mains), per side — kept separate from charsByGame so that increasing
  // the game count later (e.g. bo3 -> bo5) can back-fill the newly-added
  // rows with it instead of leaving them empty.
  const [allGamesChar, setAllGamesChar] = useState<{ winner: Character | null; loser: Character | null }>({
    winner: null,
    loser: null,
  });
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  // Corrections made this session via editMain, keyed by playerId — checked
  // ahead of entrant.suggestedMainCharacterId in resolveMain so a fix is
  // reflected immediately (m re-applies it) without waiting on a refetch.
  // null is a real value here (cleared, not "no correction"); a missing key
  // means "no correction made," which is why this can't just be
  // Record<number, number | null> defaulted to undefined-means-unset.
  const [mainOverrides, setMainOverrides] = useState<Map<number, number | null>>(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Bumped each time Enter is pressed on a score that cannot be reported. A
  // counter rather than a flag so the same refusal twice still re-triggers the
  // highlight — the second press is exactly when a TO is wondering why.
  const [scoreNudge, setScoreNudge] = useState(0);
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
    if (mode.kind === 'confirmSubmit' || mode.kind === 'confirmReset') confirmSubmitRef.current?.scrollIntoView({ block: 'nearest' });
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

  /**
   * Why the Report button is dead, when the error itself is deliberately not
   * shown.
   *
   * showError hides parseError while the preview still has something to draw,
   * because every such buffer is a valid prefix of a real score — typing
   * "wwlw" passes through "w", "ww" and "wwl", and flashing an error at each
   * would fight the TO on a correct entry. But the button is disabled in
   * exactly those states, and a dead control with no reason is its own bug.
   *
   * In all of them the set winner is simply short of requiredWins, so one
   * sentence covers them — and it names the Bo toggle, because the realistic
   * way a TO gets stuck here is guessRequiredWins picking Bo5 for a set that
   * was actually Bo3. Their 2-0 is right; the format is wrong.
   */
  const shortfallHint =
    parseError != null && displayGames.length > 0 && winnerGameCount < requiredWins
      ? `${winnerGameCount} of ${requiredWins} wins — Bo${requiredWins * 2 - 1} (press b to change)`
      : null;

  const reportable = Boolean(games) && parseError === null;
  const nudging = scoreNudge > 0 && !reportable;

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

  // Single source of truth for "what do we know about this player's main,
  // and how much should that be trusted" — resolveMain and the status line
  // rendered near "All games" both derive from this, so they can never say
  // two different things. Precedence: a same-session correction (editMain)
  // beats a persisted one (setsConsidered: 0 — the same upsert path, just
  // from an earlier session), which beats the auto-computed suggestion (from
  // the player's own recent start.gg history), which beats the old
  // hardcoded web/src/mains.ts lookup — a fallback for players with no
  // computable main yet (e.g. too new to have 10 sets on record).
  function mainStatus(entrant: EntrantInfo): MainStatus {
    if (entrant.playerId != null && mainOverrides.has(entrant.playerId)) {
      const overrideId = mainOverrides.get(entrant.playerId) ?? null;
      return { kind: 'manual', character: overrideId != null ? (characters.find((c) => c.id === overrideId) ?? null) : null };
    }
    const suggested = entrant.suggestedMain;
    if (suggested) {
      const character = suggested.characterId != null ? (characters.find((c) => c.id === suggested.characterId) ?? null) : null;
      if (suggested.setsConsidered === 0) return { kind: 'manual', character };
      return { kind: 'suggested', character, gamesTallied: suggested.gamesTallied, setsConsidered: suggested.setsConsidered };
    }
    const fallback = lookupMain(entrant.name, characters);
    return fallback ? { kind: 'fallback', character: fallback } : { kind: 'none' };
  }

  function resolveMain(entrant: EntrantInfo): Character | null {
    const status = mainStatus(entrant);
    return status.kind === 'none' ? null : status.character;
  }

  // gamesTallied counts games, setsConsidered counts sets (a Bo5 can supply
  // several games to one set), so the two are never combined into a single
  // fraction — that would look like a percentage but silently mix units.
  function describeMainStatus(status: MainStatus): string {
    switch (status.kind) {
      case 'none':
        return 'no main on file';
      case 'manual':
        return status.character ? `${status.character.name} — set manually` : 'no main on file';
      case 'fallback':
        return status.character.name;
      case 'suggested':
        return status.character
          ? `${status.character.name} — seen in ${status.gamesTallied} games across their last ${status.setsConsidered} sets`
          : `no clear main in their last ${status.setsConsidered} sets`;
    }
  }

  // Corrects what's on file for this player going forward — distinct from
  // charsByGame, which only ever describes this one report. Applied to local
  // state immediately regardless of how the request resolves: a failure here
  // means the correction won't be remembered next time this player comes up,
  // not that anything about the report currently being filled in is wrong,
  // so it isn't worth a blocking error of its own.
  function correctMain(side: CharSide, item: Character | null) {
    const entrant = side === 'winner' ? winner : loser;
    if (entrant.playerId == null) return;
    const playerId = entrant.playerId;
    setMainOverrides((prev) => new Map(prev).set(playerId, item?.id ?? null));
    setMode({ kind: 'game' });
    updatePlayerMain(playerId, videogameId, item?.id ?? null).catch((err) => {
      console.error(`Failed to save corrected main for player ${playerId}:`, err);
    });
  }

  function applyMains() {
    const winnerMain = resolveMain(winner);
    const loserMain = resolveMain(loser);
    if (!winnerMain && !loserMain) {
      // Otherwise m is a silent no-op indistinguishable from not having
      // registered the keypress at all — the status line above "All games"
      // already shows "no main on file" up front, but this confirms the
      // keypress itself did something (or rather, correctly did nothing).
      onNotify('No main on file for either player — pick one manually, or correct it above.', 'info');
      return;
    }
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

  function buildPayload(confirmReset: boolean): ReportPayload | null {
    if (!games || games.length === 0) return null;
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

    return {
      setId: set.id,
      winnerEntrantId: winner.id,
      loserEntrantId: loser.id,
      requiredWins: submitRequiredWins,
      shorthand: submitShorthand,
      characters: charactersPayload.length > 0 ? charactersPayload : undefined,
      stages: stagesPayload.length > 0 ? stagesPayload : undefined,
      // So every other TO watching this pool sees the result immediately,
      // rather than each of them polling start.gg to find out.
      phaseGroupId: phaseGroupId == null ? undefined : String(phaseGroupId),
      // Only ever true on a second submit, made from the confirmation the
      // refusal opens — so the destructive path cannot be reached without
      // the TO having seen what it costs.
    confirmReset,
    };
  }

  async function submit(confirmReset = false) {
    if (submittingRef.current) return;
    const payload = buildPayload(confirmReset);
    if (!payload) return;

    // Changing who won is the one thing here that destroys work, and what it
    // destroys can only be worked out server-side. So this one report is not
    // queued until the TO has seen the answer: the ask below writes nothing.
    const changingWinner = priorWinnerEntrantId !== null && priorWinnerEntrantId !== winner.id;
    if (changingWinner && !confirmReset) {
      submittingRef.current = true;
      setSubmitting(true);
      try {
        await reportSet({ ...payload, attempt: 1 });
        // The server disagreed that the winner was changing — this set was
        // not decided after all, and the report simply landed.
        onDone();
      } catch (err) {
        if (onAuthError(err)) return;
        if (err instanceof ApiError && err.details?.requiresReset === true) {
          const clears = err.details.wouldClear;
          setMode({ kind: 'confirmReset', wouldClear: Array.isArray(clears) ? (clears as string[]) : null });
          return;
        }
        onNotify(err instanceof Error ? err.message : 'Failed to report set', 'error');
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
      return;
    }

    onQueue(payload, `${winner.name} vs ${loser.name}`);
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
        if (helpOpen) {
          e.preventDefault();
          setHelpOpen(false);
          return;
        }
        if (mode.kind === 'confirmLeave') {
          onCancel();
          return;
        }
        e.preventDefault();
        (active as HTMLElement | null)?.blur?.();
        if (mode.kind === 'game') {
          if (focusedRow != null) setFocusedRow(null);
          else setMode({ kind: 'confirmLeave' });
        } else if (mode.kind === 'confirmSubmit' || mode.kind === 'confirmReset') {
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

      if (mode.kind === 'confirmReset') {
        e.preventDefault();
        if (e.key === 'Enter') {
          submit(true);
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
        // Confirming a score the panel has already decided it will not accept
        // just moved the dead end one keypress further along: the confirm row
        // appeared and its Enter did nothing.
        if (!games || parseError) {
          setScoreNudge((n) => n + 1);
          return;
        }
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

  /**
   * A player's main as the icon itself rather than a sentence about it.
   *
   * Dim until it has actually been applied to the games — which is the whole
   * distinction the old line of text was spending a row to make ("seen in 4
   * games across their last 4 sets" told a TO what was on file, not whether it
   * was going in). Pressing m fills the games and lights it up. The sentence
   * survives as the icon's tooltip, where it costs nothing.
   */
  function mainStatusRow(side: CharSide) {
    const entrant = side === 'winner' ? winner : loser;
    const status = mainStatus(entrant);
    const character = status.kind === 'none' ? null : status.character;
    const applied = character !== null && allGamesChar[side]?.id === character.id;
    return (
      <div className="main-status-line">
        <span className="main-status-name">{entrant.name}</span>
        {character ? (
          <img
            className={`main-status-icon${applied ? '' : ' dim'}`}
            src={character.imageUrl}
            alt={character.name}
            // describeMainStatus already leads with the character's name.
            title={`${describeMainStatus(status)}${applied ? '' : ' · press m to use it'}`}
          />
        ) : (
          <span className="main-status-text">no main on file</span>
        )}
        <button type="button" onClick={() => setMode({ kind: 'editMain', side })}>
          ✎ correct
        </button>
      </div>
    );
  }

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
      {/* Fixed: the whole page used to scroll, so this scrolled away for a
          moment before sticking, which read as a glitch. */}
      <div className="report-header">
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

      {priorResult && (
        <p className="prior-result">
          Already reported: <strong>{priorResult.winnerName}</strong> def. {priorResult.loserName}
          {priorResult.winnerScore !== null && priorResult.loserScore !== null
            ? ` ${priorResult.winnerScore}–${priorResult.loserScore}`
            : ''}{' '}
          — reporting below will overwrite this.
        </p>
      )}

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
        </div>

        {/* The result itself, rather than a line of header text: it is the one
            thing on this screen a TO has to be sure of before confirming. */}
        {mode.kind !== 'quick' && (
          <div className={`score-display${nudging ? ' nudge' : ''}`} key={scoreNudge}>
            <span className="score-line">
              {winner.name}{' '}
              <span className="score-value">
                <span className="score-won">{winnerGameCount}</span>–<span className="score-lost">{loserGameCount}</span>
              </span>{' '}
              {loser.name}
            </span>
            {shortfallHint && <span className="score-shortfall">{shortfallHint}</span>}
            {/* Nothing typed leaves no shortfall line to point at, so the
                refusal needs something of its own to say. */}
            {nudging && !shortfallHint && !showError && <span className="score-blocked">Type a score to report this set.</span>}
          </div>
        )}
      </div>

      <div className="report-body">
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
      </div>

      {mode.kind !== 'quick' && (
        <div
          className={`game-stats-section ${
            mode.kind === 'game' || mode.kind === 'characters' || mode.kind === 'stages' || mode.kind === 'editMain'
              ? 'focused'
              : ''
          } ${charPending ? 'char-pending' : ''}`}
        >
          {mode.kind === 'editMain' ? (
            <div className="edit-main-row">
              <span className="edit-main-label">Correct {mode.side === 'winner' ? winner.name : loser.name}'s main</span>
              <FuzzyCell
                items={characters}
                matchItems={fuzzyMatchCharacters}
                value={null}
                placeholder="type a character, or clear…"
                active
                onCommit={(c) => correctMain(mode.side, c)}
                onCancel={() => setMode({ kind: 'game' })}
              />
              <button type="button" className="edit-main-clear" onClick={() => correctMain(mode.side, null)}>
                clear
              </button>
            </div>
          ) : (
            (winner.playerId != null || loser.playerId != null) && (
              <div className="edit-main-row edit-main-triggers">
                {winner.playerId != null && mainStatusRow('winner')}
                {loser.playerId != null && mainStatusRow('loser')}
              </div>
            )
          )}

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

      </div>

      <div className="report-actions">
      {mode.kind === 'confirmReset' ? (
        <div className="confirm-row submit-confirm" ref={confirmSubmitRef}>
          <p className="reset-warning">
            {winner.name} didn't win this on start.gg, so the result has to be cleared and reported again.{' '}
            {mode.wouldClear === null
              ? "Couldn't check what else that clears."
              : mode.wouldClear.length > 0
                ? `That also clears ${mode.wouldClear.join(', ')}.`
                : 'Nothing else has been played off it yet.'}
          </p>
          <button
            className="confirm-yes"
            onClick={() => submit(true)}
            disabled={submitting}
            aria-label={submitting ? 'Reporting…' : 'Clear the old result and report this one'}
          >
            {submitting ? '…' : '✓'}
          </button>
          <button className="confirm-no" onClick={() => setMode({ kind: 'game' })} disabled={submitting} aria-label="Cancel">
            ✕
          </button>
        </div>
      ) : mode.kind === 'confirmSubmit' ? (
        <div className="confirm-row submit-confirm" ref={confirmSubmitRef}>
          <button
            className="confirm-yes"
            // Wrapped, not passed directly: submit's first parameter is
            // confirmReset, and a click handler would hand it a MouseEvent —
            // truthy — silently authorising a teardown nobody was shown.
            onClick={() => submit()}
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

      </div>

      {/* Collapsed into a corner: the notation is worth having once, and worth
          nothing on every set after that, while it took a permanent strip off
          the bottom of a screen that needs the room. */}
      <button
        type="button"
        className="report-help-trigger"
        onClick={() => setHelpOpen((open) => !open)}
        aria-expanded={helpOpen}
        aria-label={helpOpen ? 'Hide the notation guide' : 'Show the notation guide'}
      >
        ?
      </button>
      {helpOpen && (
        <div className="report-help-popover" role="dialog" aria-label="Notation guide">
          <div className="tool-label">
            <div>
              Score — digits (124, -3, +sweep), <kbd>w</kbd>/<kbd>l</kbd>, or <kbd>←</kbd>/<kbd>→</kbd> ·{' '}
              <kbd>↑</kbd>/<kbd>↓</kbd> or click to pick a game · <kbd>g</kbd> to refocus · <kbd>q</kbd> for quick set
              count
            </div>
            <div>
              Best of — <kbd>b</kbd>/<kbd>bo</kbd> + an odd number
            </div>
            <div>
              Characters — <kbd>c</kbd>, then <kbd>w</kbd>/<kbd>l</kbd> (starts on all games), then numbers to target
              games (stack multiple) or <kbd>a</kbd> for all · <kbd>m</kbd> fills in mains anytime · wrong main on
              file? correct it above "All games"
            </div>
            {stages.length > 0 && (
              <div>
                Stage — <kbd>s</kbd>, then a game number
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
