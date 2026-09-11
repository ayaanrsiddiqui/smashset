import { layoutBracket, BOX_HEIGHT, BOX_WIDTH, LINK_WIDTH } from './bracketLayout';
import { bracketSetById, isOpenable, isWinnerSlot, slotLabel } from './bracketDisplay';
import { compareIdentifiers } from './identifierOrder';
import type { BracketGroup, BracketSet } from './types';

// The only two shapes with an elimination tree to draw — round robin and
// Swiss don't have a bracket structure at all, so they fall back to a plain
// per-round list instead.
const ELIMINATION_TYPES = new Set(['SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION']);
// How far a cross-phase link's dashed stub extends from the box edge before
// the label starts — the rest of LINK_WIDTH is the label itself.
const LINK_STUB = 20;

interface Props {
  group: BracketGroup | null;
  onSelectSet: (s: BracketSet) => void;
}

export function Bracket({ group, onSelectSet }: Props) {
  if (!group) {
    return <p className="bracket-empty">No bracket data yet.</p>;
  }
  return ELIMINATION_TYPES.has(group.bracketType) ? (
    <BracketTree sets={group.sets} onSelectSet={onSelectSet} />
  ) : (
    <FallbackList sets={group.sets} />
  );
}

function BracketTree({ sets, onSelectSet }: { sets: BracketSet[]; onSelectSet: (s: BracketSet) => void }) {
  const layout = layoutBracket(sets);
  const byId = bracketSetById(sets);
  const boxById = new Map(layout.boxes.map((b) => [String(b.set.id), b]));

  if (layout.boxes.length === 0) {
    return <p className="bracket-empty">No bracket data yet.</p>;
  }

  return (
    <div className="bracket-scroll">
      <div className="bracket-canvas" style={{ width: layout.width, height: layout.height }}>
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
              const slotY = y + (link.slotIndex === 0 ? BOX_HEIGHT / 4 : (BOX_HEIGHT * 3) / 4);
              const x0 = link.side === 'right' ? x + BOX_WIDTH : x - LINK_STUB;
              const x1 = link.side === 'right' ? x + BOX_WIDTH + LINK_STUB : x;
              return <path key={`${s.id}-${link.slotIndex}-${link.side}`} className="bracket-link-stub" d={`M ${x0} ${slotY} H ${x1}`} />;
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
          return (
            <div key={s.id}>
              <div
                className={`bracket-box${clickable ? ' clickable' : ''}`}
                style={{ left: x, top: y, width: BOX_WIDTH, height: BOX_HEIGHT }}
                onClick={clickable ? () => onSelectSet(s) : undefined}
              >
                <span className="bracket-badge">{s.identifier}</span>
                {s.slots.map((slot, i) => {
                  const won = isWinnerSlot(s, slot);
                  return (
                    <div key={i} className={`bracket-row${won ? ' winner' : ''}`}>
                      <span className="bracket-name">{slotLabel(slot, byId)}</span>
                      {s.state === 3 && slot.score !== null && <span className={`bracket-score ${won ? 'won' : 'lost'}`}>{slot.score}</span>}
                    </div>
                  );
                })}
              </div>
              {links.map((link) => (
                <div
                  key={`${link.side}-${link.slotIndex}`}
                  className={`bracket-link bracket-link-${link.side}`}
                  style={{
                    top: y + (link.slotIndex === 0 ? BOX_HEIGHT / 4 : (BOX_HEIGHT * 3) / 4),
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
