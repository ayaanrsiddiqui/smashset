// Shared by App (owns the actual toast state/timeout) and ReportPanel
// (surfaces its own report-submit and mains outcomes through the same
// mechanism via the onNotify prop) — one toast system for the whole app.
export type ToastKind = 'success' | 'error' | 'info';

export interface EntrantInfo {
  id: number;
  name: string;
  playerId?: number;
  // Present only once a background lookup has actually run for this player —
  // absent means "still computing," not "confirmed no main" (which is
  // characterId: null with a real setsConsidered instead).
  suggestedMain?: {
    characterId: number | null;
    gamesTallied: number;
    setsConsidered: number;
  };
}

export interface OpenSet {
  id: number | string;
  isPreview: boolean;
  isStarted: boolean;
  fullRoundText: string;
  identifier: string;
  lPlacement: number | null;
  entrants: EntrantInfo[];
}

export interface Character {
  id: number;
  name: string;
  imageUrl?: string;
}

export interface Stage {
  id: number;
  name: string;
}

export interface CurrentUser {
  id: number;
  displayName: string;
}

export interface AccountDetails {
  displayName: string;
  startggSlug: string | null;
  topXBo5: number | null;
}

export interface EventInfo {
  id: number;
  name: string;
  slug: string;
  videogame: { id: number; name: string };
  tournament: { id: number; name: string };
}

// One phase/pool a TO can choose to view and manage — see PoolPicker.
export interface PhaseGroupSummary {
  id: number;
  displayIdentifier: string;
  phaseId: number;
  phaseName: string;
  /** Sorts phases; see the server's PhaseGroupSummary for why not phaseOrder. */
  phaseNumSeeds: number;
  bracketType: string;
}

export interface BracketSlot {
  entrant: { id: number; name: string } | null;
  score: number | null;
  // The id of the set (elsewhere in the same BracketGroup) this slot is fed
  // by, or null once the slot is filled or its prereq is a seed rather than
  // another set (first-round slots). Compare as strings — Set.id round-trips
  // from start.gg as a number, prereqSetId as a string.
  prereqSetId: string | null;
  // 1 = this slot gets the winner of prereqSetId, 2 = the loser.
  prereqPlacement: 1 | 2 | null;
  // Where this slot's entrant qualified in from, when this phaseGroup isn't
  // the first one they entered (e.g. a bracket phase fed by pools) — null
  // for a slot fed by a prior set in this same group, or seeded from the
  // event's initial registration.
  progressionOrigin: { phaseName: string; poolName: string | null } | null;
}

export interface BracketSet {
  id: number | string;
  identifier: string;
  round: number;
  fullRoundText: string;
  state: number;
  winnerId: number | null;
  lPlacement: number | null;
  // Unix seconds, null until finished — orders completed sets most-recent-first.
  completedAt: number | null;
  slots: [BracketSlot, BracketSlot];
  // The later phase this set's winner/loser placement advances into, if
  // any (a pool's terminal matches) — null when this set's result only
  // matters within its own phaseGroup.
  winnerAdvancesToPhase: string | null;
  loserAdvancesToPhase: string | null;
}

export interface BracketGroup {
  phaseGroupId: number;
  phaseName: string;
  displayIdentifier: string;
  bracketType: string;
  sets: BracketSet[];
}

// The result already on file for a set being re-opened for correction —
// see ReportPanel's `priorResult` prop.
export interface PriorResult {
  winnerName: string;
  loserName: string;
  // Null for a disqualification, which has a winner but no score.
  winnerScore: number | null;
  loserScore: number | null;
}

export interface SetDetailGame {
  orderNum: number;
  winnerEntrantId: number;
  stageId: number | null;
  // Character id per entrant who made a pick, keyed by that entrant's id.
  characterIdByEntrantId: Record<number, number>;
}

// Per-game breakdown for one already-completed set, fetched on demand (not
// part of the polled bracket data) — see ReportPanel's `priorDetail` prop.
export interface SetDetail {
  games: SetDetailGame[];
}
