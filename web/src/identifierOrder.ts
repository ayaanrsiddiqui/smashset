// start.gg assigns each match's `identifier` (A, B, C ... Z, AA, AB, ...) in
// a stable, meaningful order — winners bracket + Grand Final fully first,
// then the losers bracket, each internally in round-then-position order
// (confirmed against a real bracket's seeding: Winners Round 1 identifiers
// A-H matched the standard 1v16, 8v9, 4v13... seed pairing top to bottom).
// Sorting by this "spreadsheet column" order (shorter strings first, then
// alphabetical) reproduces start.gg's own ordering without us having to
// model bracket shape or seeding math ourselves.
export function compareIdentifiers(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
