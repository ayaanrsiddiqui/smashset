import { describe, expect, it } from 'vitest';
import { anchoredScroll, clampZoom, fitZoom, MAX_ZOOM, MIN_ZOOM, zoomStep } from './bracketZoom';

describe('how far out a bracket may be pulled', () => {
  it('leaves a normal zoom alone', () => {
    expect(clampZoom(0.8)).toBe(0.8);
  });

  it('will not shrink a bracket past readable', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it('will not blow it up indefinitely', () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });

  it('falls back to normal size for a stored value that is not a number', () => {
    // Only reachable via a hand-edited or half-written localStorage entry. A
    // view preference is worth degrading rather than throwing over.
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Number('nonsense'))).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });
});

describe('stepping with the buttons', () => {
  it('shows more bracket, then less again', () => {
    const out = zoomStep(1, -1);
    expect(out).toBeLessThan(1);
    expect(zoomStep(out, 1)).toBeCloseTo(1, 10);
  });

  it('stops at the limits instead of running away', () => {
    let zoom = 1;
    for (let i = 0; i < 40; i++) zoom = zoomStep(zoom, -1);
    expect(zoom).toBe(MIN_ZOOM);
    for (let i = 0; i < 40; i++) zoom = zoomStep(zoom, 1);
    expect(zoom).toBe(MAX_ZOOM);
  });
});

describe('fitting the whole bracket on screen', () => {
  it('shrinks a wide bracket until it fits across', () => {
    expect(fitZoom({ width: 1200, height: 400 }, { width: 600, height: 700 })).toBeCloseTo(0.5, 5);
  });

  it('actually fits the largest real bracket on a phone, rather than nearly', () => {
    // Measured from the 116-entrant bracket at start.gg/fireslam23test on
    // 2026-09-12. A floor picked by feel (0.25) could not fit this on a phone
    // OR a laptop, and "fit" that does not fit is a button that lies — so this
    // asserts the outcome, and fails if the layout grows or MIN_ZOOM rises.
    const huge = { width: 1952, height: 3032 };
    const phonePortrait = { width: 380, height: 520 };

    const zoom = fitZoom(huge, phonePortrait);

    expect(huge.width * zoom).toBeLessThanOrEqual(phonePortrait.width);
    expect(huge.height * zoom).toBeLessThanOrEqual(phonePortrait.height);
  });

  it('fits by height when that is the tighter side', () => {
    expect(fitZoom({ width: 500, height: 2000 }, { width: 400, height: 400 })).toBeCloseTo(0.2, 5);
  });

  it('never magnifies a small bracket — fit means see all of it', () => {
    expect(fitZoom({ width: 300, height: 200 }, { width: 1200, height: 900 })).toBe(1);
  });

  it('stays inside the zoom limits even for an enormous bracket', () => {
    expect(fitZoom({ width: 100_000, height: 100_000 }, { width: 380, height: 700 })).toBe(MIN_ZOOM);
  });

  it('answers normal size when it has nothing to measure', () => {
    // A stage with no size yet, i.e. fit pressed before layout settled.
    expect(fitZoom({ width: 2400, height: 900 }, { width: 0, height: 0 })).toBe(1);
    expect(fitZoom({ width: 0, height: 0 }, { width: 380, height: 700 })).toBe(1);
  });
});

describe('keeping the same part of the bracket under the eye', () => {
  it('holds the focal point still while zooming in', () => {
    // 200px scrolled, finger 100px into the viewport, doubling: whatever was
    // under the finger was at content x=300, so it is at 600 afterwards and
    // the scroll has to be 500 for it to still sit 100px in.
    expect(anchoredScroll(200, 100, 2)).toBe(500);
  });

  it('holds it still while zooming out', () => {
    expect(anchoredScroll(500, 100, 0.5)).toBe(200);
  });

  it('does not scroll past the start of the bracket', () => {
    // Zooming far out would otherwise ask for a negative offset, which the
    // browser clamps silently — and then the anchor is wrong by that much.
    expect(anchoredScroll(10, 100, 0.25)).toBe(0);
  });

  it('leaves the view alone when the zoom has not changed', () => {
    expect(anchoredScroll(340, 100, 1)).toBe(340);
  });
});
