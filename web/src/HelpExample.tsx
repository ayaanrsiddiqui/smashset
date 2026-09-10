import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameResult, HelpExampleData, HelpFocus, HelpStep } from './helpExamples';
import { HELP_MAX_ROWS, HELP_REQUIRED_WINS } from './helpExamples';
import foxIcon from './assets/help/fox.png';
import falcoIcon from './assets/help/falco.png';
import marthIcon from './assets/help/marth.png';

const STEP_MS = 3000;

const CHAR_COLORS: Record<string, string> = { Fox: '#c9713f', Falco: '#4a6fb5', Marth: '#3ba3a3' };
const CHAR_ICONS: Record<string, string> = { Fox: foxIcon, Falco: falcoIcon, Marth: marthIcon };

function charColor(name: string): string {
  if (CHAR_COLORS[name]) return CHAR_COLORS[name];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 45%, 40%)`;
}

// Every key belongs to exactly one step (the one whose upTo first reaches
// it) — what a hover scrubs the whole card to, independent of wherever
// auto-play currently is.
function computeKeyStepIndices(steps: HelpStep[], keyCount: number): (number | undefined)[] {
  const stepOf: (number | undefined)[] = new Array(keyCount);
  let prevUpTo = -1;
  steps.forEach((step, si) => {
    for (let i = prevUpTo + 1; i <= step.upTo; i++) stepOf[i] = si;
    prevUpTo = step.upTo;
  });
  return stepOf;
}

interface ResolvedPreview {
  names: { winner: string; loser: string } | null;
  score: { w: number; l: number } | null;
  games: GameResult[] | null;
  focus: HelpFocus | null;
  search: { query: string; result: { num: number; names: string } | null } | null;
}

// names/score/games accumulate across steps — a step that doesn't mention
// one means "unchanged since the last step that set it." `focus`/`search`
// are the opposite: never inherited, since which box (if any) is focused,
// or whether the search screen is even what's on-screen, is only ever true
// for the one step that says so.
function resolveSteps(steps: HelpStep[]): ResolvedPreview[] {
  let lastNames: ResolvedPreview['names'] = null;
  let lastScore: ResolvedPreview['score'] = null;
  let lastGames: ResolvedPreview['games'] = null;
  return steps.map((step) => {
    const p = step.preview ?? {};
    if (p.names) lastNames = p.names;
    if (p.score) lastScore = p.score;
    if (p.games) lastGames = p.games;
    return {
      names: lastNames,
      score: lastScore,
      games: lastGames,
      focus: p.focus ?? null,
      search: p.search ?? null,
    };
  });
}

// The one status class an icon shows, in precedence order — matches the
// real character tool, where an open/pending box always beats the green
// "already decided" tint. `g` is undefined for a game the typed score
// hasn't reached yet — focus can still land on it ("all games" reaches
// every row, played or not), it just can't be `won` without a result.
function iconState(
  g: GameResult | undefined,
  side: 'winner' | 'loser',
  gameNum: number,
  focus: HelpFocus | null
): 'pending' | 'active' | 'won' | null {
  if (focus) {
    if (focus.pending) return 'pending';
    if (focus.side === side) {
      if (focus.target === 'all' || (Array.isArray(focus.target) && focus.target.includes(gameNum))) {
        return 'active';
      }
    }
  }
  if (!g) return null;
  const won = side === 'winner' ? g.r === 'w' : g.r === 'l';
  return won ? 'won' : null;
}

function CharBadge({ name, state }: { name?: string; state: 'pending' | 'active' | 'won' | null }) {
  const className = 'help-mini-icon' + (state ? ` ${state}` : '');
  if (!name) return <span className={className} />;
  const icon = CHAR_ICONS[name];
  if (icon) {
    return (
      <span className={className} title={name}>
        <img src={icon} alt={name} />
      </span>
    );
  }
  return (
    <span className={className} title={name} style={{ background: charColor(name) }}>
      {name.slice(0, 2)}
    </span>
  );
}

// `g` is undefined for a game not decided yet (still live, just not typed to
// yet) — different from `unused`, a game past the clinch point that could
// never happen at all.
function GameRow({
  g,
  gameNum,
  focus,
  unused,
}: {
  g?: GameResult;
  gameNum: number;
  focus: HelpFocus | null;
  unused: boolean;
}) {
  return (
    <div className={'help-mini-game-row' + (unused ? ' unused' : '')}>
      <CharBadge name={g?.w} state={iconState(g, 'winner', gameNum, focus)} />
      <span className="help-mini-arrows">
        <span className={'help-mini-arrow' + (g?.r === 'w' ? ' active' : '')}>←</span>
        <span className={'help-mini-arrow' + (g?.r === 'l' ? ' active' : '')}>→</span>
      </span>
      <CharBadge name={g?.l} state={iconState(g, 'loser', gameNum, focus)} />
    </div>
  );
}

function PreviewPane({ preview }: { preview: ResolvedPreview }) {
  if (!preview.names && !preview.search) return null;

  // Two mutually exclusive sub-views, matching the app itself: the search
  // screen is what's on screen before a winner's picked, then selecting one
  // replaces the whole screen with the report panel.
  if (preview.names) {
    const score = preview.score ?? { w: 0, l: 0 };
    const games = preview.games ?? [];
    const wins = games.filter((g) => g.r === 'w').length;
    const clinchedAt = games.length > 0 && wins >= HELP_REQUIRED_WINS ? games.length : null;
    return (
      <div className="help-mini-score-view">
        <div className="help-mini-scoreline">
          <span className="lead">{preview.names.winner}</span> {score.w}–{score.l} {preview.names.loser}
        </div>
        <div className="help-mini-games">
          {Array.from({ length: HELP_MAX_ROWS }, (_, i) => (
            <GameRow
              key={i}
              g={games[i]}
              gameNum={i + 1}
              focus={preview.focus}
              unused={clinchedAt != null && i >= clinchedAt}
            />
          ))}
        </div>
      </div>
    );
  }

  const s = preview.search!;
  return (
    <div className="help-mini-search">
      <div className="help-mini-search-box">
        {s.query}
        <span className="help-mini-search-cursor" />
      </div>
      {s.result && (
        <div className="help-mini-result">
          <span className="help-mini-result-num">{s.result.num}</span>
          <span className="help-mini-result-names">{s.result.names}</span>
        </div>
      )}
    </div>
  );
}

export function HelpExample({ data, index }: { data: HelpExampleData; index: number }) {
  const resolved = useMemo(() => resolveSteps(data.steps), [data]);
  const keyStepIdx = useMemo(() => computeKeyStepIndices(data.steps, data.keys.length), [data]);
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    []
  );

  const [stepIdx, setStepIdx] = useState(data.steps.length - 1);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors `stepIdx` synchronously for the mouseleave handler, which needs
  // to know where auto-play actually is right now to decide whether to
  // restart the timer at all — state updates aren't visible until the next
  // render, but this ref is.
  const stepIdxRef = useRef(stepIdx);
  const seenRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    stepIdxRef.current = stepIdx;
  }, [stepIdx]);

  function clearTimer() {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function advance() {
    setStepIdx((i) => {
      if (i >= data.steps.length - 1) {
        clearTimer();
        return i;
      }
      return i + 1;
    });
  }

  function startTimerFrom(idx: number) {
    clearTimer();
    if (reducedMotion || idx >= data.steps.length - 1) return;
    timerRef.current = setInterval(advance, STEP_MS);
  }

  function play() {
    clearTimer();
    if (reducedMotion) {
      setStepIdx(data.steps.length - 1);
      return;
    }
    setStepIdx(0);
    startTimerFrom(0);
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !seenRef.current) {
            seenRef.current = true;
            play();
          }
        });
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => clearTimer, []);

  const displayIdx = hoverIdx ?? stepIdx;
  const activeStep = data.steps[displayIdx];

  return (
    <section className="help-example" ref={containerRef}>
      <div className="help-example-head">
        <span className="help-example-num">{String(index + 1).padStart(2, '0')}</span>
        <div>
          <h3>{data.title}</h3>
          <p>{data.blurb}</p>
        </div>
      </div>

      <div className="help-input-log">
        {/* Hovering a key scrubs the whole card to that key's step and pauses
            auto-play. The row (not each key) owns the listener: mouseover is
            delegated so crossing the gap between two keys re-targets straight
            to the new one instead of first falling back to the resting state
            — a per-key mouseleave/enter pair would flicker through that
            resting state on every transition, since the gap belongs to
            neither key. Only actually leaving the row's bounds (mouseleave
            doesn't fire for motion between a parent and its children)
            restores wherever auto-play actually was and resumes it. */}
        <div
          className="help-key-row"
          onMouseOver={(e) => {
            const target = (e.target as HTMLElement).closest('[data-key-idx]');
            if (!target) return;
            const idx = Number(target.getAttribute('data-key-idx'));
            const si = keyStepIdx[idx];
            if (si == null) return;
            clearTimer();
            setHoverIdx(si);
          }}
          onMouseLeave={() => {
            setHoverIdx(null);
            startTimerFrom(stepIdxRef.current);
          }}
        >
          {data.keys.map((k, i) => (
            <span
              key={i}
              data-key-idx={i}
              className={
                'help-key' +
                (k.kind === 'literal' ? ' literal' : '') +
                (i < activeStep.upTo ? ' done' : i === activeStep.upTo ? ' active' : '')
              }
            >
              {k.label}
            </span>
          ))}
        </div>

        <div className="help-log-foot">
          <button type="button" className="help-replay-btn" onClick={play}>
            Replay ↺
          </button>
        </div>

        {/* All steps render at once, stacked in the same grid cell (only the
            active one visible) — the card reserves height at whichever step
            is tallest, so it doesn't resize as playback or a hover moves
            between a short search-box moment and a five-row score grid. */}
        <div className="help-preview-stack">
          {resolved.map((preview, i) => (
            <div key={i} className="help-preview-slot" style={{ visibility: i === displayIdx ? 'visible' : 'hidden' }}>
              <p className="help-caption" dangerouslySetInnerHTML={{ __html: data.steps[i].caption }} />
              <PreviewPane preview={preview} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
