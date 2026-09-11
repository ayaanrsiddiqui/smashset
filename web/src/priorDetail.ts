import type { Character, SetDetail, Stage } from './types';

export interface DerivedPriorState {
  shorthand: string;
  requiredWins: number;
  charsByGame: Record<number, { winner: Character | null; loser: Character | null }>;
  stagesByGame: Record<number, Stage | null>;
}

// Turns a fetched per-game breakdown into ReportPanel's own initial-state
// shape, relative to whichever entrant is being treated as the winner for
// this correction (normally the set's actual recorded winner) — so the form
// opens already reflecting what was really played instead of a blank slate.
// Returns null when there's nothing usable to seed from (no game records at
// all — e.g. a quick-reported set, or the detail fetch came up empty), so
// the caller can fall back to today's blank-form behavior rather than
// showing a half-populated one.
export function derivePriorState(detail: SetDetail, winnerId: number, loserId: number, characters: Character[], stages: Stage[]): DerivedPriorState | null {
  if (detail.games.length === 0) return null;

  const sorted = [...detail.games].sort((a, b) => a.orderNum - b.orderNum);
  let shorthand = '';
  let wins = 0;
  const charsByGame: DerivedPriorState['charsByGame'] = {};
  const stagesByGame: DerivedPriorState['stagesByGame'] = {};

  for (const g of sorted) {
    const winnerWonThisGame = g.winnerEntrantId === winnerId;
    shorthand += winnerWonThisGame ? 'W' : 'L';
    if (winnerWonThisGame) wins++;

    const winnerCharId = g.characterIdByEntrantId[winnerId];
    const loserCharId = g.characterIdByEntrantId[loserId];
    charsByGame[g.orderNum] = {
      winner: winnerCharId != null ? (characters.find((c) => c.id === winnerCharId) ?? null) : null,
      loser: loserCharId != null ? (characters.find((c) => c.id === loserCharId) ?? null) : null,
    };
    stagesByGame[g.orderNum] = g.stageId != null ? (stages.find((s) => s.id === g.stageId) ?? null) : null;
  }

  return { shorthand, requiredWins: wins, charsByGame, stagesByGame };
}
