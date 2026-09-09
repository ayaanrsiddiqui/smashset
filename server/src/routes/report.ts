import { Router } from 'express';
import { gql } from '../startgg.js';
import { parseScoreShorthand } from '../scoreParser.js';

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
}

interface GameDataInput {
  gameNum: number;
  winnerId: number;
  stageId?: number;
  selections?: { entrantId: number; characterId: number }[];
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
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  if (typeof body.setId === 'string' && body.setId.startsWith('preview_')) {
    res.status(400).json({
      error: 'This set is still a bracket preview (the bracket hasn\'t been started on start.gg yet), so it has no real set to report against.',
    });
    return;
  }

  let games;
  try {
    games = parseScoreShorthand(body.shorthand, body.requiredWins);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid score' });
    return;
  }

  const gameData = buildGameData(body as ReportBody, games);

  try {
    const data = await gql(req.user!.accessToken, REPORT_MUTATION, {
      setId: body.setId,
      winnerId: body.winnerEntrantId,
      gameData,
    });
    res.json({ result: data, games });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to report set' });
  }
});
