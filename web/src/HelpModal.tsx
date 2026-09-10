import { useEffect } from 'react';
import { HELP_EXAMPLES } from './helpExamples';
import { HelpExample } from './HelpExample';

const REFERENCE_GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Search',
    rows: [
      ['/', "focus search, then type part of the winner's tag"],
      ['1–9', 'jump straight to a labeled result'],
      ['⏎', "report the top result if it's the right one"],
    ],
  },
  {
    title: 'Score',
    rows: [
      ['124 / -3', 'games the winner took, or the one game they lost'],
      ['w / l', 'per game, in order — wwlw'],
      ['← / →', 'same as w / l, one game at a time'],
      ['↑ / ↓', 'or click, to focus a specific row and correct it'],
      ['+ / − / 0', 'clean sweep, sized to the current Bo'],
      ['Backspace', 'undo the last keystroke'],
      ['g', 'refocus the score, clearing anything typed'],
      ['q', 'quick score instead — no per-game detail, e.g. 3-1'],
      ['f', 'flip the winner — only the two names move'],
    ],
  },
  {
    title: 'Format',
    rows: [['b / bo + N', 'set best-of-N when the Bo1/3/5 guess is wrong']],
  },
  {
    title: 'Characters',
    rows: [
      ['c', 'open the tool — every box outlines while you choose a side'],
      ['w / l', 'that side, defaulting to "all games"'],
      ['1–9', 'target one game instead — stack more digits for several at once'],
      ['a', 'back to "all games"'],
      ['name, ⏎', 'fuzzy-matched, aliases included — "gnw" finds Mr. Game & Watch'],
      ['m', "fill in both players' registered mains"],
    ],
  },
  {
    title: 'Stages',
    rows: [['s, 1–9', 'a game number, then the stage name, then ⏎']],
  },
  {
    title: 'Confirm & escape',
    rows: [
      ['⏎', 'once to ask, again to actually report'],
      ['Escape', 'back out one level — twice from the top leaves without reporting'],
    ],
  },
];

interface Props {
  onClose: () => void;
}

export function HelpModal({ onClose }: Props) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div
        className="help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="help-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="help-modal-body">
          <h2 id="help-modal-title">SmashSet notation</h2>
          <p className="help-intro">
            Every report is one unbroken sequence of keys — no clicking into a text box, no reaching for the
            mouse. Four real reports, keystroke by keystroke, then the full reference for whatever these don't
            cover.
          </p>

          {HELP_EXAMPLES.map((example, i) => (
            <HelpExample key={example.title} data={example} index={i} />
          ))}

          <section className="help-reference">
            <h3>Full reference</h3>
            <p>Everything above, generalized. Read this once the examples make sense, not before.</p>
            <div className="help-ref-groups">
              {REFERENCE_GROUPS.map((group) => (
                <div className="help-ref-group" key={group.title}>
                  <h4>{group.title}</h4>
                  {group.rows.map(([k, desc]) => (
                    <div className="help-ref-row" key={k}>
                      <span className="help-ref-key">{k}</span>
                      <span className="help-ref-desc">{desc}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="help-footnote">
              Nothing above sends until the final <span className="help-ref-key-inline">⏎</span> at a
              confirmation. Anything else typed there cancels it, so a stray keystroke can't report a set by
              accident.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
