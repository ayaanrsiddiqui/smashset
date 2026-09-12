// A real 116-entrant bracket lays out at 1952 x 3032px (measured 2026-09-12),
// so on a phone the bracket view shows a handful of sets and no shape at all —
// and the binding dimension is height, not width, because double elimination
// stacks the losers side under the winners side. Panning already works (the
// stage is a plain scroller); what was missing is being able to pull back far
// enough to see where a player actually is.

/**
 * The floor, from a stated model rather than taste: a box stays at least about
 * 24px wide (BOX_WIDTH is 188), which is the point below which the bracket
 * stops reading as boxes at all.
 *
 * It also has to be low enough that "fit" genuinely fits, or the button lies.
 * Measured on the real 116-entrant bracket at start.gg/fireslam23test on
 * 2026-09-12 — 1952 x 3032px — which needs 0.17 to fit a phone in portrait and
 * 0.23 on a laptop. A first guess of 0.25 would have fitted neither; see the
 * test that fails if either the layout or this number drifts far enough to
 * break it again.
 */
export const MIN_ZOOM = 0.12;
/**
 * Capped a little above 1 rather than far above: the boxes are sized for
 * reading already, and the reason to zoom in is a phone held at arm's length
 * at a venue, not inspection.
 */
export const MAX_ZOOM = 2;
/** One button press. Roughly a quarter more or less bracket on screen. */
const ZOOM_STEP = 1.25;

/**
 * A zoom that is safe to render at.
 *
 * Deliberately degrades a nonsense value to 1 rather than throwing: the only
 * way one gets here is a hand-edited or half-written localStorage entry, and
 * a bracket drawn at its normal size is a perfectly good answer to that. It is
 * a view preference, not a score.
 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function zoomStep(zoom: number, direction: 1 | -1): number {
  return clampZoom(direction === 1 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP);
}

/**
 * The zoom that puts the whole bracket on screen.
 *
 * Never above 1: "fit" means being able to see all of it, and blowing a
 * four-set bracket up to double size is not what a TO pressing that asked for.
 */
export function fitZoom(
  content: { width: number; height: number },
  visible: { width: number; height: number }
): number {
  if (content.width <= 0 || content.height <= 0 || visible.width <= 0 || visible.height <= 0) return 1;
  return clampZoom(Math.min(visible.width / content.width, visible.height / content.height, 1));
}

/**
 * Where to scroll to so that whatever was under `focal` stays under it.
 *
 * Without this, zooming out walks the bracket sideways: the scroll offset is
 * in pre-zoom pixels, so the same number means somewhere else afterwards and
 * the set the TO was looking at slides off screen. `focal` is measured from
 * the left/top edge of the visible area — the midpoint between two fingers for
 * a pinch, the centre of the viewport for a button.
 */
export function anchoredScroll(scroll: number, focal: number, ratio: number): number {
  return Math.max(0, (scroll + focal) * ratio - focal);
}
