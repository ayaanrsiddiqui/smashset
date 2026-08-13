import { Router } from 'express';
import { gql } from '../startgg.js';
import { parseScoreShorthand } from '../scoreParser.js';

export const reportRouter = Router();

interface CharacterSelections {
  mode: 'set' | 'perGame';
  winnerCharacterId?: number;
  loserCharacterId?: number;
  perGame?: { gameNum: number; winnerCharacterId?: number; loserCharacterId?: number }[];
}

interface ReportBody {
  setId: number;
  winnerEntrantId: number;
  loserEntrantId: number;
  requiredWins: number;
  shorthand: string;
  characters?: CharacterSelections;
}

interface GameDataInput {
  gameNum: number;
  winnerId: number;
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

    const chars = body.characters;
    if (!chars) return gameData;

    let winnerCharacterId: number | undefined;
    let loserCharacterId: number | undefined;

    if (chars.mode === 'set') {
      winnerCharacterId = chars.winnerCharacterId;
      loserCharacterId = chars.loserCharacterId;
    } else {
      const g = chars.perGame?.find((pg) => pg.gameNum === gameNum);
      winnerCharacterId = g?.winnerCharacterId;
      loserCharacterId = g?.loserCharacterId;
    }

    const selections: { entrantId: number; characterId: number }[] = [];
    if (winnerCharacterId != null) {
      selections.push({ entrantId: body.winnerEntrantId, characterId: winnerCharacterId });
    }
    if (loserCharacterId != null) {
      selections.push({ entrantId: body.loserEntrantId, characterId: loserCharacterId });
    }
    if (selections.length > 0) gameData.selections = selections;

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

  let games;
  try {
    games = parseScoreShorthand(body.shorthand, body.requiredWins);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid score' });
    return;
  }

  const gameData = buildGameData(body as ReportBody, games);

  try {
    const data = await gql(REPORT_MUTATION, {
      setId: body.setId,
      winnerId: body.winnerEntrantId,
      gameData,
    });
    res.json({ result: data, games });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to report set' });
  }
});
