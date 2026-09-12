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
  side: 'left' | 'right';
  label: string;
  /**
   * Where the stub leaves the box, as a fraction of its height. A left link
   * belongs to one slot, so it sits on that slot's half. A right link belongs
   * to the set — nothing about it is per-slot — so it centres, unless the
   * winner and the loser go to different phases and there are two to tell
   * apart.
   */
  at: number;
}

const TOP_SLOT = 0.25;
const BOTTOM_SLOT = 0.75;
const WHOLE_BOX = 0.5;

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
    links.push({
      side: 'left',
      at: slotIndex === 0 ? TOP_SLOT : BOTTOM_SLOT,
      label: poolName ? `${phaseName} ${poolName}` : phaseName,
    });
  });
  return links;
}

// A last-column set's winner/loser advancing into a later phase (a pool's
// terminal matches), if any.
//
// This used to wait for the set to be decided, on the reasoning that until
// then there is no slot to attach the label to. The premise was wrong: the
// link belongs to the *set* ("whoever wins this goes to top 8"), not to a
// slot, so there is nothing to wait for — and start.gg draws it on unplayed
// sets, verified against its own render of fireslam23test's HUGE bracket,
// where all four qualifying sets carry "top 8" while still undecided. Waiting
// also hid it exactly when a TO wants it: before the set is played.
function rightLinksFor(s: BracketSet): PhaseLink[] {
  const links: PhaseLink[] = [];
  const both = s.winnerAdvancesToPhase !== null && s.loserAdvancesToPhase !== null;
  if (s.winnerAdvancesToPhase) {
    links.push({ side: 'right', at: both ? TOP_SLOT : WHOLE_BOX, label: `${s.winnerAdvancesToPhase} [W]` });
  }
  if (s.loserAdvancesToPhase) {
    links.push({ side: 'right', at: both ? BOTTOM_SLOT : WHOLE_BOX, label: `${s.loserAdvancesToPhase} [L]` });
  }
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

  // Which sets in the immediately preceding column feed each set. Only
  // same-row, same-hop links count — a losers set's winners-bracket dropdown
  // is deliberately not a feeder, matching start.gg, which draws no connector
  // for it either.
  const feedersOf = new Map<string, BracketSet[]>();
  columnsOfSets.forEach((col, colIndex) => {
    const prev = colIndex > 0 ? new Map(columnsOfSets[colIndex - 1].map((p) => [String(p.id), p])) : null;
    for (const s of col) {
      const feeders: BracketSet[] = [];
      if (prev) {
        for (const slot of s.slots) {
          const feeder = slot.prereqSetId ? prev.get(slot.prereqSetId) : undefined;
          if (feeder && !feeders.includes(feeder)) feeders.push(feeder);
        }
      }
      feeders.sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
      feedersOf.set(String(s.id), feeders);
    }
  });

  const edges: LayoutEdge[] = [];
  const yById = new Map<string, number>();
  let nextLeafRow = 0;

  // Depth-first from the last column back, handing every *unfed* set the next
  // free row as it is reached. A set with no feeders is not necessarily in the
  // first column: byes mean a losers round can hold sets whose loser-side slot
  // comes from a bye set start.gg does not return, and whose winner-side slot
  // is a cross-row dropdown. Positioning those by their index within the
  // column — which is what this used to do — puts them at a y another set in
  // the same column has already been given, so they render exactly on top of
  // each other and one of the two is invisible.
  //
  // Walking the tree instead gives each such set a row *where it belongs in
  // the bracket*, and reproduces start.gg's own geometry exactly, including
  // the uneven gaps an early losers column gets when only some of the sets it
  // feeds are fed in turn. Feeders are always in the preceding column, so the
  // recursion strictly decreases in column index and cannot cycle.
  const place = (s: BracketSet): number => {
    const key = String(s.id);
    const already = yById.get(key);
    if (already !== undefined) return already;

    const feeders = feedersOf.get(key) ?? [];
    let y: number;
    if (feeders.length === 0) {
      y = HEADER_HEIGHT + nextLeafRow * ROW_STEP;
      nextLeafRow += 1;
    } else {
      const feederYs = feeders.map((f) => {
        edges.push({ fromId: String(f.id), toId: key });
        return place(f);
      });
      y = feederYs.reduce((a, b) => a + b, 0) / feederYs.length;
    }
    yById.set(key, y);
    return y;
  };

  // The final column holds the roots; anything earlier that nothing feeds into
  // is unreachable from them and only gets a row once they are all placed.
  for (let colIndex = columnsOfSets.length - 1; colIndex >= 0; colIndex--) {
    for (const s of columnsOfSets[colIndex]) place(s);
  }

  const boxes: LayoutBox[] = [];
  const columns: LayoutColumn[] = [];
  let maxY = 0;
  const lastColIndex = columnsOfSets.length - 1;

  columnsOfSets.forEach((col, colIndex) => {
    const x = colIndex * COLUMN_STEP;
    columns.push({ x, y: 0, text: col[0].fullRoundText });
    for (const s of col) {
      const y = yById.get(String(s.id))!;
      const links = [...(colIndex === 0 ? leftLinksFor(s) : []), ...(colIndex === lastColIndex ? rightLinksFor(s) : [])];
      boxes.push({ set: s, x, y, links });
      maxY = Math.max(maxY, y);
    }
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
