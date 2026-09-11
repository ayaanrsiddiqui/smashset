import { compareIdentifiers } from './identifierOrder';
import type { BracketSet } from './types';

export const BOX_WIDTH = 188;
export const BOX_HEIGHT = 56;
export const HEADER_HEIGHT = 32;
// Gap between columns is generous on purpose — it's where the elbow
// connectors live, and start.gg's own bracket leaves similar breathing room.
const COLUMN_STEP = BOX_WIDTH + 64;
const ROW_STEP = BOX_HEIGHT + 16;
const SECTION_GAP = 48;
// Horizontal space reserved for a cross-phase link's label + dashed stub,
// at whichever edge(s) of the canvas actually have one (see PhaseLink).
export const LINK_WIDTH = 168;

export interface PhaseLink {
  slotIndex: 0 | 1;
  side: 'left' | 'right';
  label: string;
}

export interface LayoutBox {
  set: BracketSet;
  x: number;
  y: number;
  links: PhaseLink[];
}

export interface LayoutColumn {
  x: number;
  y: number;
  text: string;
}

export interface LayoutEdge {
  fromId: string;
  toId: string;
}

export interface BracketLayout {
  boxes: LayoutBox[];
  columns: LayoutColumn[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

interface RowLayout {
  boxes: LayoutBox[];
  columns: LayoutColumn[];
  edges: LayoutEdge[];
  height: number;
}

const EMPTY_ROW: RowLayout = { boxes: [], columns: [], edges: [], height: 0 };

// A first-column slot's cross-phase origin (e.g. a bracket phase fed by
// pools), if any.
function leftLinksFor(s: BracketSet): PhaseLink[] {
  const links: PhaseLink[] = [];
  s.slots.forEach((slot, slotIndex) => {
    if (!slot.progressionOrigin) return;
    const { phaseName, poolName } = slot.progressionOrigin;
    links.push({ slotIndex: slotIndex as 0 | 1, side: 'left', label: poolName ? `${phaseName} ${poolName}` : phaseName });
  });
  return links;
}

// A last-column set's winner/loser advancing into a later phase (a pool's
// terminal matches), if any. Only rendered once the set is actually
// decided — winnerProgressionSeed/loserProgressionSeed are structural
// (set up whenever the bracket/pools are generated) and can be present
// before the match is played, but which physical slot ends up "the
// winner" isn't known until it is, so there's nothing correct to attach
// the label to before then.
function rightLinksFor(s: BracketSet): PhaseLink[] {
  if (s.winnerId === null) return [];
  const links: PhaseLink[] = [];
  s.slots.forEach((slot, slotIndex) => {
    const isWinner = slot.entrant?.id === s.winnerId;
    const advancesTo = isWinner ? s.winnerAdvancesToPhase : s.loserAdvancesToPhase;
    if (advancesTo) links.push({ slotIndex: slotIndex as 0 | 1, side: 'right', label: `${advancesTo} [${isWinner ? 'W' : 'L'}]` });
  });
  return links;
}

// Lays out one bracket "row" (either every winners-side set, including
// Grand Final(s), or every losers-side set) as its own independent
// left-to-right sequence of columns — see bracketLayout's own comment for
// why winners/losers aren't forced into shared column x-positions.
function layoutRow(sets: BracketSet[], columnCompare: (a: BracketSet, b: BracketSet) => number): RowLayout {
  if (sets.length === 0) return EMPTY_ROW;

  // Bucket into columns by fullRoundText, in the order columnCompare puts
  // their sets in (so e.g. Grand Final's column comes before Grand Final
  // Reset's, both round 5 — broken only by identifier, since round alone
  // ties).
  const columnsOfSets: BracketSet[][] = [];
  const columnIndexByText = new Map<string, number>();
  for (const s of [...sets].sort(columnCompare)) {
    let idx = columnIndexByText.get(s.fullRoundText);
    if (idx === undefined) {
      idx = columnsOfSets.length;
      columnIndexByText.set(s.fullRoundText, idx);
      columnsOfSets.push([]);
    }
    columnsOfSets[idx].push(s);
  }
  // Top-to-bottom order within a column matches start.gg's own identifier
  // assignment order (see identifierOrder.ts) — no seeding math needed.
  for (const col of columnsOfSets) col.sort((a, b) => compareIdentifiers(a.identifier, b.identifier));

  const boxes: LayoutBox[] = [];
  const columns: LayoutColumn[] = [];
  const edges: LayoutEdge[] = [];
  const yById = new Map<string, number>();
  let maxY = 0;
  const lastColIndex = columnsOfSets.length - 1;

  columnsOfSets.forEach((col, colIndex) => {
    const x = colIndex * COLUMN_STEP;
    columns.push({ x, y: 0, text: col[0].fullRoundText });
    const prevCol = colIndex > 0 ? columnsOfSets[colIndex - 1] : null;
    const prevIds = prevCol ? new Set(prevCol.map((p) => String(p.id))) : null;

    col.forEach((s, rowIndex) => {
      let y: number;
      const sourceIds = new Set<string>();
      if (prevIds) {
        for (const slot of s.slots) {
          if (slot.prereqSetId && prevIds.has(slot.prereqSetId)) sourceIds.add(slot.prereqSetId);
        }
      }
      if (sourceIds.size > 0) {
        const sourceYs = [...sourceIds].map((id) => yById.get(id)!);
        y = sourceYs.reduce((a, b) => a + b, 0) / sourceYs.length;
        for (const id of sourceIds) edges.push({ fromId: id, toId: String(s.id) });
      } else {
        // First column of this row, or (defensively) a match whose prereqs
        // don't resolve within this row — fall back to even spacing rather
        // than stacking every box at y 0.
        y = HEADER_HEIGHT + rowIndex * ROW_STEP;
      }
      yById.set(String(s.id), y);
      const links = [...(colIndex === 0 ? leftLinksFor(s) : []), ...(colIndex === lastColIndex ? rightLinksFor(s) : [])];
      boxes.push({ set: s, x, y, links });
      maxY = Math.max(maxY, y);
    });
  });

  return { boxes, columns, edges, height: maxY + BOX_HEIGHT };
}

function topColumnCompare(a: BracketSet, b: BracketSet): number {
  return a.round - b.round || compareIdentifiers(a.identifier, b.identifier);
}

// Losers-bracket round numbers count *down* as the bracket progresses
// (confirmed against real start.gg data: a 16-entrant bracket's Losers
// Round 1 was round -3, its Losers Final was round -8) — so "closer to
// zero" is earlier, the opposite of the winners side.
function bottomColumnCompare(a: BracketSet, b: BracketSet): number {
  return b.round - a.round || compareIdentifiers(a.identifier, b.identifier);
}

// Lays out one phaseGroup's worth of elimination-bracket sets the way
// start.gg's own bracket page does: winners bracket (plus Grand Final and
// Grand Final Reset, which share the next round number after Winners
// Final) as one row of columns, losers bracket as an independent row of
// columns underneath it. A column's boxes are positioned by averaging the
// y of whichever of their prereq sets landed in the immediately preceding
// column *of the same row* — cross-row links (a winners-round loser
// dropping into the losers bracket, or the losers finalist advancing to
// Grand Final) intentionally don't affect position or draw a connector,
// matching start.gg's own rendering (verified by hand-tracing a real
// 16-entrant bracket start to finish).
//
// A pool phaseGroup additionally carries links to *other* phases — a
// pool's terminal matches feed seeds in a later phase (right edge), and its
// opening matches are sometimes themselves filled by seeds that progressed
// in from an earlier phase (left edge), both confirmed against a real
// multi-pool tournament. Space for whichever edges actually have one is
// reserved uniformly (same margin for both rows), so the two rows' columns
// still line up with each other on each side.
export function layoutBracket(sets: BracketSet[]): BracketLayout {
  const top = sets.filter((s) => s.round > 0);
  const bottom = sets.filter((s) => s.round < 0);

  const topRow = layoutRow(top, topColumnCompare);
  const bottomRow = layoutRow(bottom, bottomColumnCompare);
  const bottomYOffset = bottom.length > 0 ? topRow.height + SECTION_GAP : 0;

  const rawBoxes: LayoutBox[] = [...topRow.boxes, ...bottomRow.boxes.map((b) => ({ ...b, y: b.y + bottomYOffset }))];
  const hasLeftLink = rawBoxes.some((b) => b.links.some((l) => l.side === 'left'));
  const leftMargin = hasLeftLink ? LINK_WIDTH : 0;

  const boxes: LayoutBox[] = rawBoxes.map((b) => ({ ...b, x: b.x + leftMargin }));
  const columns: LayoutColumn[] = [...topRow.columns, ...bottomRow.columns.map((c) => ({ ...c, y: c.y + bottomYOffset }))].map((c) => ({
    ...c,
    x: c.x + leftMargin,
  }));
  const edges: LayoutEdge[] = [...topRow.edges, ...bottomRow.edges];

  const rightMost = boxes.length > 0 ? Math.max(...boxes.map((b) => b.x + BOX_WIDTH + (b.links.some((l) => l.side === 'right') ? LINK_WIDTH : 0))) : 0;
  const width = boxes.length > 0 ? rightMost : 0;
  const height = bottom.length > 0 ? bottomYOffset + bottomRow.height : topRow.height;

  return { boxes, columns, edges, width, height };
}
