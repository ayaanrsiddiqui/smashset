import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layoutBracket, BOX_HEIGHT, BOX_WIDTH, LINK_WIDTH } from './bracketLayout';
import { bracketSetById, isOpenable, isUnreachedGrandFinalReset, isWinnerSlot, slotLabel } from './bracketDisplay';
import { compareIdentifiers } from './identifierOrder';
import { anchoredScroll, clampZoom, fitZoom, MAX_ZOOM, MIN_ZOOM, zoomStep } from './bracketZoom';
import { upsetFactor } from './upsetFactor';
import { MAX_SET_CHARACTERS } from './setCharacters';
import type { BracketGroup, BracketSet, Character } from './types';

// The only two shapes with an elimination tree to draw — round robin and
// Swiss don't have a bracket structure at all, so they fall back to a plain
// per-round list instead.
const ELIMINATION_TYPES = new Set(['SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION']);
// How far a cross-phase link's dashed stub extends from the box edge before
// the label starts — the rest of LINK_WIDTH is the label itself.
const LINK_STUB = 20;
// Remembered like the chosen event and pool are: a TO settles on a comfortable
// size once at a venue and should not have to find it again after a reload.
const ZOOM_STORAGE_KEY = 'smashset.bracketZoom';

function storedZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    return raw === null ? 1 : clampZoom(Number(raw));
  } catch {
    // A browser refusing storage just means the bracket opens at normal size.
    return 1;
  }
}

/**
 * The part of the stage nothing is floating over — inset by the space reserved
 * for the set panel and, on a narrow screen, the zoom controls.
 *
 * The stage reserves those as padding (see App.css), so fitting or centring
 * against clientWidth alone parks part of the bracket under the panel and
 * calls it visible.
 */
function visibleArea(stage: HTMLElement): { left: number; top: number; width: number; height: number } {
  const style = getComputedStyle(stage);
  const left = parseFloat(style.paddingLeft) || 0;
  const top = parseFloat(style.paddingTop) || 0;
  return {
    left,
    top,
    width: stage.clientWidth - left - (parseFloat(style.paddingRight) || 0),
    height: stage.clientHeight - top - (parseFloat(style.paddingBottom) || 0),
  };
}

interface Props {
  group: BracketGroup | null;
  onSelectSet: (s: BracketSet) => void;
  /**
   * The set currently highlighted in the list — scrolled into view and marked
   * here, so the list and the bracket are two views of one selection rather
   * than two things sharing a screen.
   */
  focusedSetId?: number | string | null;
  /**
   * Turns a slot's characterId into an icon. Empty until the videogame's
   * character list loads, and most sets on a real bracket carry no character
   * at all — plenty of TOs never report picks — so the icon is always optional.
   */
  characters?: Character[];
}

export function Bracket({ group, onSelectSet, focusedSetId, characters = [] }: Props) {
  if (!group) {
    return <p className="bracket-empty">No bracket data yet.</p>;
  }
  return ELIMINATION_TYPES.has(group.bracketType) ? (
    <BracketTree sets={group.sets} onSelectSet={onSelectSet} focusedSetId={focusedSetId} characters={characters} />
  ) : (
    <FallbackList sets={group.sets} />
  );
}

function BracketTree({
  sets,
  onSelectSet,
  focusedSetId,
  characters,
}: {
  sets: BracketSet[];
  onSelectSet: (s: BracketSet) => void;
  focusedSetId?: number | string | null;
  characters: Character[];
}) {
  // Built once per render rather than per slot; a bracket has hundreds.
  const iconUrlById = useMemo(
    () => new Map(characters.flatMap((c) => (c.imageUrl ? ([[c.id, c.imageUrl]] as [number, string][]) : []))),
    [characters]
  );
  // Dropped before layout, so the whole "Grand Final Reset" column goes with
  // it rather than leaving an empty header behind.
  const drawn = useMemo(() => sets.filter((s) => !isUnreachedGrandFinalReset(s)), [sets]);
  const layout = layoutBracket(drawn);
  // Kept over every set, not just the drawn ones: slotLabel resolves "winner
  // of X" through this, and a hidden reset is still some other slot's prereq.
  const byId = bracketSetById(sets);
  const boxById = new Map(layout.boxes.map((b) => [String(b.set.id), b]));
  const focusedRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(storedZoom);
  // Where to put the scroll offset once the canvas has been re-laid-out at the
  // new size. Applied in a layout effect rather than inline, because until
  // React has committed the new dimensions the scroller still has the old
  // scrollable range and clamps anything past it.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  const stageOf = () => (scrollRef.current?.closest('.bracket-stage') as HTMLElement | null) ?? null;

  /**
   * Zooms, keeping whatever is under `focal` where it is — the midpoint
   * between two fingers for a pinch, the centre of the visible area for a
   * button. `focal` is in client coordinates.
   */
  function applyZoom(next: number, focal?: { x: number; y: number }) {
    const clamped = clampZoom(next);
    setZoom((current) => {
      if (clamped === current) return current;
      const stage = stageOf();
      if (stage) {
        const rect = stage.getBoundingClientRect();
        const visible = visibleArea(stage);
        const fx = focal ? focal.x - rect.left : visible.left + visible.width / 2;
        const fy = focal ? focal.y - rect.top : visible.top + visible.height / 2;
        const ratio = clamped / current;
        pendingScroll.current = {
          left: anchoredScroll(stage.scrollLeft, fx, ratio),
          top: anchoredScroll(stage.scrollTop, fy, ratio),
        };
      }
      return clamped;
    });
  }

  // Read by the gesture listeners below, which are attached once and would
  // otherwise hold the zoom and the handler from first render forever.
  const zoomRef = useRef(zoom);
  const applyZoomRef = useRef(applyZoom);
  zoomRef.current = zoom;
  applyZoomRef.current = applyZoom;

  useLayoutEffect(() => {
    const target = pendingScroll.current;
    const stage = stageOf();
    pendingScroll.current = null;
    if (!target || !stage) return;
    stage.scrollLeft = target.left;
    stage.scrollTop = target.top;
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // See storedZoom: a browser refusing storage costs the preference, not
      // the feature.
    }
  }, [zoom]);

  /**
   * Pinch, and the trackpad gesture that reports itself as ctrl+wheel.
   *
   * Registered by hand rather than with React's props because React attaches
   * touchmove and wheel as passive listeners, where preventDefault does
   * nothing — and without preventDefault the browser zooms the whole page
   * (header, panel and all) on top of what this does.
   */
  useEffect(() => {
    const stage = stageOf();
    if (!stage) return;

    let pinchStartDistance = 0;
    let pinchStartZoom = 1;
    const spread = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 2) {
        pinchStartDistance = 0;
        return;
      }
      pinchStartDistance = spread(e.touches);
      pinchStartZoom = zoomRef.current;
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length !== 2 || pinchStartDistance === 0) return;
      e.preventDefault();
      applyZoomRef.current(pinchStartZoom * (spread(e.touches) / pinchStartDistance), {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      });
    }

    function endPinch() {
      pinchStartDistance = 0;
    }

    function onWheel(e: WheelEvent) {
      // A plain wheel is scrolling the bracket, which already works.
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoomRef.current(zoomRef.current * (1 - e.deltaY / 200), { x: e.clientX, y: e.clientY });
    }

    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', endPinch);
    stage.addEventListener('touchcancel', endPinch);
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
      stage.removeEventListener('touchend', endPinch);
      stage.removeEventListener('touchcancel', endPinch);
      stage.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fitToScreen() {
    const stage = stageOf();
    if (!stage) return;
    applyZoom(fitZoom({ width: layout.width, height: layout.height }, visibleArea(stage)));
  }

  // Centre the highlighted set in the part of the stage that isn't behind the
  // floating panel. The stage reserves that space as padding (see App.css), so
  // subtracting it here keeps the set clear of the panel on both dock edges.
  // Reads getBoundingClientRect, which already accounts for the zoom.
  useEffect(() => {
    const box = focusedRef.current;
    const stage = box?.closest('.bracket-stage') as HTMLElement | null;
    if (!box || !stage) return;

    const visible = visibleArea(stage);
    const boxRect = box.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();

    stage.scrollBy({
      left: boxRect.left + boxRect.width / 2 - (stageRect.left + visible.left + visible.width / 2),
      top: boxRect.top + boxRect.height / 2 - (stageRect.top + visible.top + visible.height / 2),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [focusedSetId]);

  if (layout.boxes.length === 0) {
    return <p className="bracket-empty">No bracket data yet.</p>;
  }

  return (
    <>
      {/* Buttons as well as pinch, not instead of it: a pinch is a multipoint
          gesture and WCAG 2.5.1 wants a single-pointer way to do the same
          thing — which is also the only way to zoom with a mouse. */}
      <div className="bracket-zoom-controls">
        <button type="button" onClick={() => applyZoom(zoomStep(zoom, -1))} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="bracket-zoom-fit" onClick={fitToScreen}>
          fit
        </button>
        <button type="button" onClick={() => applyZoom(zoomStep(zoom, 1))} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in">
          +
        </button>
        <span className="bracket-zoom-level">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="bracket-scroll" ref={scrollRef}>
        <div className="bracket-zoom-sizer" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
      <div className="bracket-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
        <svg className="bracket-edges" width={layout.width} height={layout.height}>
          {layout.edges.map((e) => {
            const from = boxById.get(e.fromId);
            const to = boxById.get(e.toId);
            if (!from || !to) return null;
            const x0 = from.x + BOX_WIDTH;
            const y0 = from.y + BOX_HEIGHT / 2;
            const x1 = to.x;
            const y1 = to.y + BOX_HEIGHT / 2;
            const midX = (x0 + x1) / 2;
            return <path key={`${e.fromId}-${e.toId}`} d={`M ${x0} ${y0} H ${midX} V ${y1} H ${x1}`} />;
          })}
          {layout.boxes.flatMap(({ set: s, x, y, links }) =>
            links.map((link) => {
              const slotY = y + link.at * BOX_HEIGHT;
              const x0 = link.side === 'right' ? x + BOX_WIDTH : x - LINK_STUB;
              const x1 = link.side === 'right' ? x + BOX_WIDTH + LINK_STUB : x;
              return <path key={`${s.id}-${link.side}-${link.label}`} className="bracket-link-stub" d={`M ${x0} ${slotY} H ${x1}`} />;
            })
          )}
        </svg>

        {layout.columns.map((c) => (
          <div key={`${c.x}-${c.y}`} className="bracket-column-header" style={{ left: c.x, top: c.y, width: BOX_WIDTH }}>
            {c.text}
          </div>
        ))}

        {layout.boxes.map(({ set: s, x, y, links }) => {
          const clickable = isOpenable(s);
          const focused = focusedSetId != null && String(s.id) === String(focusedSetId);
          // Only a finished set has a result to have been an upset.
          const winnerSlot = s.slots.find((slot) => isWinnerSlot(s, slot));
          const loserSlot = s.slots.find((slot) => slot !== winnerSlot);
          const upset =
            s.state === 3 && winnerSlot && loserSlot
              ? upsetFactor(winnerSlot.seedNum, loserSlot.seedNum)
              : null;
          return (
            <div key={s.id}>
              <div
                ref={focused ? focusedRef : undefined}
                className={`bracket-box${clickable ? ' clickable' : ''}${focused ? ' focused' : ''}`}
                style={{ left: x, top: y, width: BOX_WIDTH, height: BOX_HEIGHT }}
                onClick={clickable ? () => onSelectSet(s) : undefined}
              >
                <span className="bracket-badge">{s.identifier}</span>
                {upset !== null && (
                  <span
                    className={`bracket-upset${upset > 0 ? ' real' : ''}`}
                    title={upset > 0 ? `Upset factor ${upset}` : 'Seeding held'}
                  >
                    {upset > 0 ? upset : '✓'}
                  </span>
                )}
                {s.slots.map((slot, i) => {
                  const won = isWinnerSlot(s, slot);
                  return (
                    <div key={i} className={`bracket-row${won ? ' winner' : ''}`}>
                      {/* Seed on the left, character on the right beside the
                          score — start.gg's own order. */}
                      <span className="bracket-seed">{slot.seedNum ?? ''}</span>
                      <span className="bracket-name">{slotLabel(slot, byId)}</span>
                      {/* alt is empty deliberately: the tag it sits beside is
                          already read out, so the icons are decoration.
                          Filtered before slicing, so a character whose icon the
                          videogame list does not carry does not silently cost
                          one of the three slots. */}
                      {(() => {
                        const icons = slot.characterIds.filter((id) => iconUrlById.has(id)).slice(0, MAX_SET_CHARACTERS);
                        if (icons.length === 0) return null;
                        // Rank 0 is the character the set was most about. With
                        // three it goes in the middle, stacked over the two
                        // either side of it; with two it leads. The rank rides
                        // on a class rather than on DOM position, because
                        // position no longer says which one belongs on top.
                        const ranked = icons.map((id, rank) => ({ id, rank }));
                        const placed = ranked.length === 3 ? [ranked[1], ranked[0], ranked[2]] : ranked;
                        return (
                          <span className="bracket-characters">
                            {placed.map(({ id, rank }) => (
                              <img key={id} className={`bracket-character rank-${rank}`} src={iconUrlById.get(id)} alt="" />
                            ))}
                          </span>
                        );
                      })()}
                      {s.state === 3 && slot.score !== null && <span className={`bracket-score ${won ? 'won' : 'lost'}`}>{slot.score}</span>}
                    </div>
                  );
                })}
              </div>
              {links.map((link) => (
                <div
                  key={`${link.side}-${link.label}`}
                  className={`bracket-link bracket-link-${link.side}`}
                  style={{
                    top: y + link.at * BOX_HEIGHT,
                    ...(link.side === 'right' ? { left: x + BOX_WIDTH + LINK_STUB } : { left: x - LINK_WIDTH, width: LINK_WIDTH - LINK_STUB }),
                    width: LINK_WIDTH - LINK_STUB,
                  }}
                >
                  {link.label}
                </div>
              ))}
            </div>
          );
        })}
      </div>
        </div>
      </div>
    </>
  );
}

// Round robin / Swiss have no elimination tree, just rounds of matches — a
// plain per-round list, reusing the same read-only row styling the
// Completed/Not-ready sections already use.
function FallbackList({ sets }: { sets: BracketSet[] }) {
  const byId = bracketSetById(sets);
  const rounds = new Map<string, BracketSet[]>();
  for (const s of [...sets].sort((a, b) => compareIdentifiers(a.identifier, b.identifier))) {
    const bucket = rounds.get(s.fullRoundText);
    if (bucket) bucket.push(s);
    else rounds.set(s.fullRoundText, [s]);
  }

  return (
    <div className="bracket-fallback">
      {[...rounds.entries()].map(([roundText, roundSets]) => (
        <div key={roundText} className="bracket-fallback-round">
          <h3>{roundText}</h3>
          <ul className="results-list">
            {roundSets.map((s) => (
              <li key={s.id} className="readonly">
                <span className="entrant-names">
                  {slotLabel(s.slots[0], byId)} vs {slotLabel(s.slots[1], byId)}
                </span>
                {s.state === 3 && <span className="round-text">completed</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
