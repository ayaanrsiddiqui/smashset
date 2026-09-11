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
    prereqSetId,
    prereqPlacement,
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
    expect(a.links).toEqual([{ slotIndex: 0, side: 'left', label: 'Pools Pool B' }]);
    // A second-column box's slot is fed by a prior set, never a
    // progressionOrigin, so it never gets a left link even if one were
    // (incorrectly) present on its data.
    const i = withLink.boxes.find((b) => b.set.id === 3)!;
    expect(i.links).toEqual([]);
    // Margin only exists because something actually needs it.
    expect(withLink.width).toBe(without.width + LINK_WIDTH);
    expect(withLink.boxes.find((b) => b.set.id === 1)!.x).toBe(without.boxes.find((b) => b.set.id === 1)!.x + LINK_WIDTH);
  });

  it('attaches a right link only to a last-column, decided set — labeled with the destination phase and W/L', () => {
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
    expect(i.links).toEqual(
      expect.arrayContaining([
        { slotIndex: 0, side: 'right', label: 'Top 8 [W]' }, // slot 0 = entrant 101 = the winner
        { slotIndex: 1, side: 'right', label: 'Losers Consolation [L]' },
      ])
    );
  });

  it('omits right links entirely for an undecided set, even with progression seeds present', () => {
    // winnerAdvancesToPhase/loserAdvancesToPhase are structural (set up when
    // the bracket/pools are generated) and can exist before the match is
    // played — but which physical slot is "the winner" isn't known yet.
    const I = set(3, 'I', 2, 'Winners Quarter-Final', [slot(101), slot(103)], {
      state: 1,
      winnerId: null,
      winnerAdvancesToPhase: 'Top 8',
      loserAdvancesToPhase: 'Losers Consolation',
    });
    const layout = layoutBracket([I]);
    expect(layout.boxes[0].links).toEqual([]);
  });

  it('leaves width unchanged when nothing has a link', () => {
    const layout = layoutBracket(fixture());
    expect(layout.boxes.every((b) => b.links.length === 0)).toBe(true);
  });
});
