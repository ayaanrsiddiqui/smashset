/**
 * How big an upset a result was, the way supermajor.gg shows it.
 *
 * Seeds are bucketed by where that seed is *projected* to place, because the
 * gap that matters is in rounds, not in seed numbers: beating seed 2 as seed 7
 * is a much bigger deal than beating seed 30 as seed 35, even though the second
 * gap is bigger. The buckets are the placement tiers a double-elimination
 * bracket actually produces — 1-2 (grands), 3 (losers final), 4 (losers semi),
 * 5-6 (losers quarters), 7-8, 9-12, and so on doubling — and the factor is how
 * many of them the winner jumped.
 */

/**
 * The last seed in each placement bucket: 2, 3, 4, 6, 8, 12, 16, 24, 32, ...
 *
 * The top three are one-offs (grands take two seeds, then losers final and
 * losers semi take one each); after that the tiers come in pairs of equal size
 * that double, which is just what each extra losers round holds.
 */
function bucketBounds(): number[] {
  const bounds = [2, 3, 4];
  let size = 2;
  let start = 5;
  // 4096 is well past any real bracket; the loop needs an end more than it
  // needs that particular number.
  while (start <= 4096) {
    bounds.push(start + size - 1);
    start += size;
    bounds.push(start + size - 1);
    start += size;
    size *= 2;
  }
  return bounds;
}

const BOUNDS = bucketBounds();

/** Which placement tier a seed is projected into. Lower is better. */
export function seedBucket(seed: number): number {
  const index = BOUNDS.findIndex((bound) => seed <= bound);
  return index === -1 ? BOUNDS.length : index;
}

/**
 * The upset factor for a finished set, or null when there is nothing to say.
 *
 * Zero means "no upset" — either the better seed won, or both were projected
 * to the same finish, which is not an upset however the seed numbers compare.
 * Null means the seeds are not known, which happens for a minute after a slot
 * fills (the seeds ride the bracket's slow structure fetch) and forever on a
 * bracket start.gg never seeded.
 */
export function upsetFactor(winnerSeed: number | null, loserSeed: number | null): number | null {
  if (winnerSeed === null || loserSeed === null) return null;
  // A higher seed *number* is the worse seed, so the winner having the higher
  // number is what makes it an upset at all.
  if (winnerSeed <= loserSeed) return 0;
  return Math.max(0, seedBucket(winnerSeed) - seedBucket(loserSeed));
}
