import { Router } from 'express';
import { gql, StartggError } from '../startgg.js';
import { publishPoolChanged } from '../poolEvents.js';
import { parseScoreShorthand } from '../scoreParser.js';
import { parseDisplayScore } from '../displayScore.js';
import { COST_MODEL, fetchSetsPaged, invalidateSetCaches } from './sets.js';
import { resetCascade, type CascadeSet } from '../resetCascade.js';

export const reportRouter = Router();

interface CharacterSelection {
  gameNum: number;
  winnerCharacterId?: number;
  loserCharacterId?: number;
}

interface StageSelection {
  gameNum: number;
  stageId: number;
}

interface ReportBody {
  setId: number | string;
  winnerEntrantId: number;
  loserEntrantId: number;
  requiredWins: number;
  shorthand: string;
  characters?: CharacterSelection[];
  stages?: StageSelection[];
  /**
   * The pool the TO is looking at, so everyone else watching it can be told
   * immediately. Only a notification hint — a wrong value makes other clients
   * refetch needlessly, it cannot show anyone data their own token would not
   * return. Absent when an older client reports; they simply poll as before.
   */
  phaseGroupId?: string;
  /**
   * The TO has seen what tearing down this result will unmake and said yes.
   * Only consulted when the winner is actually changing; the route refuses
   * that outright without it, so the destructive path cannot be reached by a
   * client that does not know it exists.
   */
  confirmReset?: boolean;
  /**
   * Which delivery this is, 1 for the first. Anything above 1 is the outbox
   * re-sending a report the TO has already walked away from, and is held to a
   * stricter rule than a TO standing at the set deciding to overwrite it.
   */
  attempt?: number;
}

interface GameDataInput {
  gameNum: number;
  winnerId: number;
  stageId?: number;
  selections?: { entrantId: number; characterId: number }[];
}

const COMPLETED_STATE = 3;

/**
 * What start.gg holds for this set right now, read before writing to it.
 *
 * Three separate reasons, none of which the client can supply — it has only
 * what its last poll returned, which is however old the TO's typing took:
 *
 *  - reportBracketSet is refused outright on a finished set ("Cannot report
 *    completed set via API.", verified live 2026-09-12), so which mutation to
 *    send depends on state.
 *  - a report naming someone who is not in the set writes its game rows before
 *    failing validation and does not roll them back (also verified live),
 *    leaving phantom games nothing in this app can clear.
 *  - whether the winner is changing decides whether this is destructive.
 */
const SET_PRECONDITION_QUERY = /* GraphQL */ `
  query ReportPrecondition($setId: ID!) {
    set(id: $setId) {
      id
      state
      winnerId
      displayScore
      phaseGroup {
        id
      }
      slots {
        entrant {
          id
          name
        }
      }
    }
  }
`;

// Edits a finished set in place. Cannot change who won — start.gg answers
// "Set winner cannot be changed with this function" — so it is only ever sent
// when the winner is staying put.
const UPDATE_MUTATION = /* GraphQL */ `
  mutation UpdateSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
    updateBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
      id
      state
    }
  }
`;

// The only way start.gg allows a finished set's winner to change. Cascading is
// not optional in practice: the old winner has already advanced, and both the
// winner's and the loser's paths carry that forward — verified live, resetting
// one winners-round set also cleared the losers-bracket set its loser fell
// into. Leaving those standing would contradict the result being written.
const RESET_MUTATION = /* GraphQL */ `
  mutation ResetSet($setId: ID!) {
    resetSet(setId: $setId, resetDependentSets: true) {
      id
      state
    }
  }
`;

interface PreconditionResult {
  set: {
    id: number | string;
    state: number;
    winnerId: number | null;
    displayScore: string | null;
    // Read from the set rather than taken from the request body, where
    // phaseGroupId is only an untrusted notification hint.
    phaseGroup: { id: number | string } | null;
    slots: { entrant: { id: number; name: string } | null }[];
  } | null;
}

/**
 * Whether trying the same request again could plausibly get a different answer.
 *
 * Without this every failure is one 502 with a message string, and an outbox
 * either hammers a refusal that can never change or gives up on a four-second
 * wifi blip. The distinction already exists inside StartggError and was simply
 * being thrown away at this boundary.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof StartggError)) return false;
  // start.gg answered, with a decision. Asking again repeats the answer.
  if (err.gqlErrors) return false;
  // No status at all means the request never got an answer: timeout, dropped
  // connection, venue wifi. Exactly the case worth waiting out.
  if (err.status === undefined) return true;
  return err.status === 429 || err.status >= 500;
}

/**
 * Whether start.gg already holds precisely the result this report describes.
 *
 * Used only to resolve a retry. Returns false whenever the answer is not
 * certain — an unreadable score (a DQ arrives as the bare string "DQ") is not
 * a matching one, and treating it as one would retire a report that never
 * landed.
 */
function alreadyOnFile(
  current: NonNullable<PreconditionResult['set']>,
  winnerEntrantId: number,
  requiredWins: number,
  totalGames: number
): boolean {
  if (String(current.winnerId) !== String(winnerEntrantId)) return false;
  const [slotA, slotB] = current.slots;
  const winnerSlot = String(slotA?.entrant?.id) === String(winnerEntrantId) ? 0 : 1;
  const scores = parseDisplayScore(current.displayScore, slotA?.entrant?.name, slotB?.entrant?.name, winnerSlot);
  const [winnerScore, loserScore] = winnerSlot === 0 ? scores : [scores[1], scores[0]];
  if (winnerScore === null || loserScore === null) return false;
  return winnerScore === requiredWins && loserScore === totalGames - requiredWins;
}

/**
 * The already-played sets a teardown of this one would wipe, named so the TO
 * can see them before agreeing. Best effort: if start.gg will not answer, the
 * confirmation still has to happen, it just cannot list what is at stake — and
 * saying so is better than blocking a correction on a failed lookup.
 */
async function wouldClear(accessToken: string, phaseGroupId: string, setId: number | string): Promise<string[] | null> {
  try {
    const paged = await fetchSetsPaged<CascadeSet, { id: number | string }>(
      accessToken,
      phaseGroupId,
      COST_MODEL.cascade.query,
      { name: 'cascade', base: COST_MODEL.cascade.base, maxPerRow: COST_MODEL.cascade.maxPerSet }
    );
    if (!paged) return null;
    return resetCascade(paged.nodes, setId).map((set) => set.identifier);
  } catch {
    return null;
  }
}

const REPORT_MUTATION = /* GraphQL */ `
  mutation ReportSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
    reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
      id
      state
    }
  }
`;

function buildGameData(
  body: ReportBody,
  games: { gameNum: number; winnerWonGame: boolean }[]
): GameDataInput[] {
  return games.map(({ gameNum, winnerWonGame }) => {
    const gameData: GameDataInput = {
      gameNum,
      winnerId: winnerWonGame ? body.winnerEntrantId : body.loserEntrantId,
    };

    const chars = body.characters?.find((c) => c.gameNum === gameNum);
    if (chars) {
      const selections: { entrantId: number; characterId: number }[] = [];
      if (chars.winnerCharacterId != null) {
        selections.push({ entrantId: body.winnerEntrantId, characterId: chars.winnerCharacterId });
      }
      if (chars.loserCharacterId != null) {
        selections.push({ entrantId: body.loserEntrantId, characterId: chars.loserCharacterId });
      }
      if (selections.length > 0) gameData.selections = selections;
    }

    const stage = body.stages?.find((s) => s.gameNum === gameNum);
    if (stage) gameData.stageId = stage.stageId;

    return gameData;
  });
}

reportRouter.post('/', async (req, res) => {
  const body = req.body as Partial<ReportBody>;

  if (
    body.setId == null ||
    body.winnerEntrantId == null ||
    body.loserEntrantId == null ||
    body.requiredWins == null ||
    typeof body.shorthand !== 'string'
  ) {
    res.status(400).json({ error: 'Missing required fields', retryable: false });
    return;
  }

  if (typeof body.setId === 'string' && body.setId.startsWith('preview_')) {
    res.status(400).json({
      error: 'This set is still a bracket preview (the bracket hasn\'t been started on start.gg yet), so it has no real set to report against.',
      retryable: false,
    });
    return;
  }

  let games;
  try {
    games = parseScoreShorthand(body.shorthand, body.requiredWins);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid score', retryable: false });
    return;
  }

  const gameData = buildGameData(body as ReportBody, games);

  let current: PreconditionResult['set'];
  try {
    ({ set: current } = await gql<PreconditionResult>(req.user!.accessToken, SET_PRECONDITION_QUERY, {
      setId: body.setId,
    }));
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Could not check this set before reporting it',
      retryable: isRetryable(err),
    });
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'start.gg no longer has this set.', retryable: false });
    return;
  }

  const entrantIds = current.slots.map((slot) => slot.entrant?.id);
  if (entrantIds.some((id) => id == null)) {
    res.status(409).json({
      error: "This set doesn't have both players yet on start.gg, so there's nothing to report against.",
      retryable: false,
    });
    return;
  }
  // Deliberately blocks rather than letting start.gg reject it: a report
  // naming a non-entrant is the one rejection that writes before it validates.
  if (!entrantIds.includes(body.winnerEntrantId) || !entrantIds.includes(body.loserEntrantId)) {
    res.status(409).json({
      error: 'This set is between different players on start.gg now — reopen it to see who, then report again.',
      retryable: false,
    });
    return;
  }

  const alreadyDecided = current.state === COMPLETED_STATE;

  // A retry is the outbox re-sending something the TO has already moved on
  // from, so it gets no licence to overwrite. Either start.gg already holds
  // exactly this result — the first attempt landed and only its response was
  // lost, which is a success, not a failure — or the set has moved and the
  // only safe thing is to stop and say so.
  if ((body.attempt ?? 1) > 1 && alreadyDecided) {
    if (alreadyOnFile(current, body.winnerEntrantId, body.requiredWins, games.length)) {
      res.json({ alreadyOnFile: true, games });
      return;
    }
    res.status(409).json({
      error: `This set now reads ${current.displayScore ?? 'differently'} on start.gg, so this report was not sent. Open it to check.`,
      retryable: false,
    });
    return;
  }

  const winnerChanged = alreadyDecided && String(current.winnerId) !== String(body.winnerEntrantId);
  if (winnerChanged && body.confirmReset !== true) {
    const clears = current.phaseGroup ? await wouldClear(req.user!.accessToken, String(current.phaseGroup.id), body.setId) : null;
    res.status(409).json({
      error: 'Changing who won means clearing this result and everything it fed into.',
      requiresReset: true,
      retryable: false,
      // null means the lookup failed, which is not the same as "nothing else
      // is affected" — the client says so rather than implying it is safe.
      wouldClear: clears,
    });
    return;
  }

  try {
    let data;
    if (winnerChanged) {
      await gql(req.user!.accessToken, RESET_MUTATION, { setId: body.setId });
      try {
        data = await gql(req.user!.accessToken, REPORT_MUTATION, {
          setId: body.setId,
          winnerId: body.winnerEntrantId,
          gameData,
        });
      } catch (err) {
        // start.gg has no transaction across two mutations, so this really does
        // leave the set with nothing on it. Saying "failed to report" would be
        // true and useless — the TO would assume the old result still stands.
        invalidateSetCaches();
        if (typeof body.phaseGroupId === 'string') publishPoolChanged(body.phaseGroupId);
        res.status(502).json({
          error: `The old result was cleared but the new one didn't save (${err instanceof Error ? err.message : 'start.gg failed'}) — this set is unreported on start.gg now. Report it again.`,
          retryable: isRetryable(err),
        });
        return;
      }
    } else if (alreadyDecided) {
      data = await gql(req.user!.accessToken, UPDATE_MUTATION, {
        setId: body.setId,
        winnerId: body.winnerEntrantId,
        gameData,
      });
    } else {
      data = await gql(req.user!.accessToken, REPORT_MUTATION, {
        setId: body.setId,
        winnerId: body.winnerEntrantId,
        gameData,
      });
    }
    // Without this the set the TO just reported keeps coming back as open
    // until the cache expires, so it stays in the list they are working from.
    invalidateSetCaches();
    // Everyone watching this pool hears about it now, rather than each of them
    // discovering it separately by asking start.gg on their next poll.
    if (typeof body.phaseGroupId === 'string') publishPoolChanged(body.phaseGroupId);
    res.json({ result: data, games });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to report set', retryable: isRetryable(err) });
  }
});
