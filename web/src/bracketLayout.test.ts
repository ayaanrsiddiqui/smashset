import { describe, expect, it } from 'vitest';
import { layoutBracket, BOX_HEIGHT, BOX_WIDTH, LINK_WIDTH } from './bracketLayout';
import type { BracketSet, BracketSlot } from './types';

function slot(
  entrantId: number | null,
  prereqSetId: string | null = null,
  prereqPlacement: 1 | 2 | null = null,
  progressionOrigin: BracketSlot['progressionOrigin'] = null
): BracketSlot {
  return {
    entrant: entrantId !== null ? { id: entrantId, name: `P${entrantId}` } : null,
    score: null,
    characterIds: [],
    prereqSetId,
    prereqPlacement,
    seedNum: null,
    progressionOrigin,
  };
}

function set(
  id: number,
  identifier: string,
  round: number,
  fullRoundText: string,
  slots: [BracketSlot, BracketSlot],
  overrides: Partial<Pick<BracketSet, 'state' | 'winnerId' | 'winnerAdvancesToPhase' | 'loserAdvancesToPhase'>> = {}
): BracketSet {
  return {
    id,
    identifier,
    round,
    fullRoundText,
    state: 1,
    winnerId: null,
    lPlacement: null,
    completedAt: null,
    slots,
    winnerAdvancesToPhase: null,
    loserAdvancesToPhase: null,
    ...overrides,
  };
}

// A small but structurally representative slice of a real double-elimination
// bracket (identifiers/round numbers/prereq shape match a real 16-entrant
// bracket inspected against start.gg directly): a winners-side 2-into-1
// merge, and — on the losers side — both a "drop-in" hop (1 same-row source
// + 1 cross-row source that must be ignored for layout) and a
// "consolidation" hop (2 same-row sources), which is exactly the mix real
// losers brackets alternate between.
function fixture(): BracketSet[] {
  const A = set(1, 'A', 1, 'Winners Round 1', [slot(101), slot(102)]);
  const B = set(2, 'B', 1, 'Winners Round 1', [slot(103), slot(104)]);
  const I = set(3, 'I', 2, 'Winners Quarter-Final', [slot(101, '1', 1), slot(103, '2', 1)]);

  const R = set(10, 'R', -3, 'Losers Round 1', [slot(102), slot(104)]);
  const S = set(11, 'S', -3, 'Losers Round 1', [slot(105), slot(106)]);
  // V's slot0 is fed by a winners-round set not present in this fixture (a
  // cross-row drop-in) — it must never influence V's position or produce an
  // edge, only V's same-row slot1 (fed by R) should.
  const V = set(12, 'V', -4, 'Losers Round 2', [slot(107, '999', 2), slot(102, '10', 1)]);
  const W = set(14, 'W', -4, 'Losers Round 2', [slot(108, '998', 2), slot(105, '11', 1)]);
  const Z = set(13, 'Z', -5, 'Losers Round 3', [slot(null, '12', 1), slot(null, '14', 1)]);

  return [A, B, I, R, S, V, W, Z];
}

describe('layoutBracket', () => {
  it('lays out the winners row left-to-right by round, centering a merge match between its two sources', () => {
    const layout = layoutBracket(fixture());
    const byId = new Map(layout.boxes.map((b) => [String(b.set.id), b]));
    const a = byId.get('1')!;
    const b = byId.get('2')!;
    const i = byId.get('3')!;

    expect(a.x).toBe(0);
    expect(b.x).toBe(0);
    expect(a.y).not.toBe(b.y); // two distinct rows in the first column
    expect(i.x).toBeGreaterThan(a.x); // a later round sits in a later column
    expect(i.y).toBeCloseTo((a.y + b.y) / 2); // centered between its two sources
  });

  it('only counts same-row prereqs toward a losers-bracket match\'s position (drop-in hop)', () => {
    const layout = layoutBracket(fixture());
    const byId = new Map(layout.boxes.map((b) => [String(b.set.id), b]));
    const r = byId.get('10')!;
    const v = byId.get('12')!;

    // V has one same-row source (R) and one cross-row source not present in
    // this fixture at all — its y must come from R alone, not be pulled
    // toward some fallback/zero value from the missing cross-row source.
    expect(v.y).toBe(r.y);
  });

  it('averages two same-row sources for a losers-bracket consolidation hop', () => {
    const layout = layoutBracket(fixture());
    const byId = new Map(layout.boxes.map((b) => [String(b.set.id), b]));
    const v = byId.get('12')!;
    const w = byId.get('14')!;
    const z = byId.get('13')!;

    expect(z.y).toBeCloseTo((v.y + w.y) / 2);
  });

  it('orders winners columns by round ascending and losers columns chronologically (closest-to-zero round first)', () => {
    const layout = layoutBracket(fixture());
    const texts = layout.columns.map((c) => c.text);
    expect(texts).toEqual([
      'Winners Round 1',
      'Winners Quarter-Final',
      'Losers Round 1',
      'Losers Round 2',
      'Losers Round 3',
    ]);
    // Winners columns increase in x; losers columns (a separate row) also
    // increase in x independently, restarting from the same x origin.
    const [wr1, wqf, lr1, lr2, lr3] = layout.columns;
    expect(wqf.x).toBeGreaterThan(wr1.x);
    expect(lr1.x).toBe(wr1.x);
    expect(lr2.x).toBeGreaterThan(lr1.x);
    expect(lr3.x).toBeGreaterThan(lr2.x);
  });

  it('positions the losers row entirely below the winners row, with a gap', () => {
    const layout = layoutBracket(fixture());
    const winnersMaxY = Math.max(...layout.boxes.filter((b) => b.set.round > 0).map((b) => b.y)) + BOX_HEIGHT;
    const losersMinY = Math.min(...layout.boxes.filter((b) => b.set.round < 0).map((b) => b.y));
    expect(losersMinY).toBeGreaterThan(winnersMaxY);
  });

  it('only creates edges for same-row prereq links, never across the winners/losers split', () => {
    const layout = layoutBracket(fixture());
    const edgeKeys = layout.edges.map((e) => `${e.fromId}->${e.toId}`);
    expect(edgeKeys).toEqual(
      expect.arrayContaining(['1->3', '2->3', '10->12', '11->14', '12->13', '14->13'])
    );
    // The cross-row prereqs (ids "999"/"998", neither present as a set in
    // this fixture) must never surface as edges.
    expect(layout.edges.some((e) => e.fromId === '999' || e.fromId === '998')).toBe(false);
    expect(layout.edges).toHaveLength(6);
  });

  it('sizes width/height to fit every box, including the box\'s own dimensions', () => {
    const layout = layoutBracket(fixture());
    for (const box of layout.boxes) {
      expect(box.x + BOX_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(box.y + BOX_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
  });

  it('handles a winners-only (single elimination) set with no losers row at all', () => {
    const A = set(1, 'A', 1, 'Winners Round 1', [slot(101), slot(102)]);
    const B = set(2, 'B', 1, 'Winners Round 1', [slot(103), slot(104)]);
    const layout = layoutBracket([A, B]);

    expect(layout.columns).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    expect(layout.boxes.every((b) => b.set.round > 0)).toBe(true);
  });

  it('returns an empty layout for no sets', () => {
    expect(layoutBracket([])).toEqual({ boxes: [], columns: [], edges: [], width: 0, height: 0 });
  });
});

describe('layoutBracket — cross-phase links', () => {
  it('attaches a left link only to a first-column slot with a progressionOrigin, and reserves margin for it', () => {
    const origin: BracketSlot['progressionOrigin'] = { phaseName: 'Pools', poolName: 'Pool B' };
    const A = set(1, 'A', 1, 'Winners Round 1', [slot(101, null, null, origin), slot(102)]);
    const B = set(2, 'B', 1, 'Winners Round 1', [slot(103), slot(104)]);
    const I = set(3, 'I', 2, 'Winners Quarter-Final', [slot(101, '1', 1), slot(103, '2', 1)]);

    const withLink = layoutBracket([A, B, I]);
    const without = layoutBracket([set(1, 'A', 1, 'Winners Round 1', [slot(101), slot(102)]), B, I]);

    const a = withLink.boxes.find((b) => b.set.id === 1)!;
    // at 0.25 = the upper half of the box, i.e. slot 0's own row.
    expect(a.links).toEqual([{ side: 'left', at: 0.25, label: 'Pools Pool B' }]);
    // A second-column box's slot is fed by a prior set, never a
    // progressionOrigin, so it never gets a left link even if one were
    // (incorrectly) present on its data.
    const i = withLink.boxes.find((b) => b.set.id === 3)!;
    expect(i.links).toEqual([]);
    // Margin only exists because something actually needs it.
    expect(withLink.width).toBe(without.width + LINK_WIDTH);
    expect(withLink.boxes.find((b) => b.set.id === 1)!.x).toBe(without.boxes.find((b) => b.set.id === 1)!.x + LINK_WIDTH);
  });

  it('attaches a right link only to a last-column set — labeled with the destination phase and W/L', () => {
    const A = set(1, 'A', 1, 'Winners Round 1', [slot(101), slot(102)], { winnerAdvancesToPhase: 'should never show — not last column' });
    const B = set(2, 'B', 1, 'Winners Round 1', [slot(103), slot(104)]);
    const I = set(3, 'I', 2, 'Winners Quarter-Final', [slot(101, '1', 1), slot(103, '2', 1)], {
      state: 3,
      winnerId: 101,
      winnerAdvancesToPhase: 'Top 8',
      loserAdvancesToPhase: 'Losers Consolation',
    });

    const layout = layoutBracket([A, B, I]);

    const a = layout.boxes.find((b) => b.set.id === 1)!;
    expect(a.links).toEqual([]); // not the last column, even though the data has a value

    const i = layout.boxes.find((b) => b.set.id === 3)!;
    // Two destinations, so they split the box between them rather than
    // overprinting each other at its middle.
    expect(i.links).toEqual([
      { side: 'right', at: 0.25, label: 'Top 8 [W]' },
      { side: 'right', at: 0.75, label: 'Losers Consolation [L]' },
    ]);
  });

  it('shows where an undecided set leads, rather than waiting for it to be played', () => {
    // This is the reverse of what it used to do. The old reasoning was that
    // until a set is decided there is no slot to hang the label on — but the
    // link belongs to the set, not a slot, so there was nothing to wait for.
    // start.gg draws these on unplayed sets too: its own render of
    // fireslam23test's HUGE bracket pool 1 carries four "top 8" links while
    // every one of those sets is still undecided. Hiding them removed the
    // information exactly when a TO is looking for it.
    const I = set(3, 'I', 2, 'Winners Quarter-Final', [slot(101), slot(103)], {
      state: 1,
      winnerId: null,
      winnerAdvancesToPhase: 'Top 8',
    });

    const layout = layoutBracket([I]);

    // One destination, so it leaves from the middle of the box — there is no
    // winning slot yet to sit beside, and inventing one would be a guess.
    expect(layout.boxes[0].links).toEqual([{ side: 'right', at: 0.5, label: 'Top 8 [W]' }]);
  });

  it('leaves width unchanged when nothing has a link', () => {
    const layout = layoutBracket(fixture());
    expect(layout.boxes.every((b) => b.links.length === 0)).toBe(true);
  });
});

// A losers round can hold more sets than the round feeding it, because byes
// fill the rest — and start.gg does not return those bye sets, so some of its
// sets have no same-row feeder at all. Modelled on Losers Round 2 of a real
// 116-entrant bracket (fireslam23test "HUGE bracket", pool 1), where 16 sets
// are fed by only 10: P and R stand in for the bye-fed ones.
function byeFedRound(): BracketSet[] {
  const X = set(1, 'X', -3, 'Losers Round 1', [slot(101), slot(102)]);
  const Y = set(2, 'Y', -3, 'Losers Round 1', [slot(103), slot(104)]);
  // P and R take a winners-bracket dropdown on one side and a bye on the
  // other, so neither slot names a set in the round before them.
  const P = set(3, 'P', -4, 'Losers Round 2', [slot(105), slot(null)]);
  const Q = set(4, 'Q', -4, 'Losers Round 2', [slot(106), slot(101, '1', 1)]);
  const R = set(5, 'R', -4, 'Losers Round 2', [slot(107), slot(null)]);
  const S = set(6, 'S', -4, 'Losers Round 2', [slot(108), slot(103, '2', 1)]);
  return [X, Y, P, Q, R, S];
}

describe('layoutBracket — a round the previous one only partly feeds', () => {
  it('gives every set in the column its own row, instead of stacking a bye-fed set on a fed one', () => {
    const { boxes } = layoutBracket(byeFedRound());
    const round2 = boxes.filter((b) => b.set.round === -4);

    expect(round2).toHaveLength(4);
    const ys = round2.map((b) => b.y);
    expect(new Set(ys).size).toBe(4);
    // Not merely distinct — far enough apart that no box covers another.
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(BOX_HEIGHT);
  });

  it('keeps the column in identifier order top to bottom', () => {
    const { boxes } = layoutBracket(byeFedRound());
    const order = boxes
      .filter((b) => b.set.round === -4)
      .sort((a, b) => a.y - b.y)
      .map((b) => b.set.identifier);

    expect(order).toEqual(['P', 'Q', 'R', 'S']);
  });

  it('lines an earlier set up with the one it feeds, rather than with the top of the column', () => {
    const { boxes } = layoutBracket(byeFedRound());
    const at = (identifier: string) => boxes.find((b) => b.set.identifier === identifier)!.y;

    // This is what start.gg does, and why its early losers rounds have uneven
    // gaps: X and Y sit beside Q and S, skipping the rows the bye-fed P and R
    // took.
    expect(at('X')).toBe(at('Q'));
    expect(at('Y')).toBe(at('S'));
  });
});
