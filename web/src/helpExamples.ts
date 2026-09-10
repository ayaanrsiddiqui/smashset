export interface HelpKey {
  label: string;
  kind?: 'literal';
}

// A game's result, from the set-winner's slot perspective — "slot" meaning
// winner-of-the-set / loser-of-the-set, not a fixed person. See ex4, where a
// flip reattaches the slots to different names without touching this data.
export interface GameResult {
  r: 'w' | 'l';
  w?: string;
  l?: string;
}

export interface SearchResult {
  num: number;
  names: string;
}

export interface HelpFocus {
  pending?: true;
  side?: 'winner' | 'loser';
  target?: 'all' | number[];
}

export interface HelpPreview {
  names?: { winner: string; loser: string };
  score?: { w: number; l: number };
  games?: GameResult[];
  focus?: HelpFocus;
  search?: { query: string; result: SearchResult | null };
}

export interface HelpStep {
  upTo: number;
  caption: string;
  preview?: HelpPreview;
}

export interface HelpExampleData {
  title: string;
  blurb: string;
  keys: HelpKey[];
  steps: HelpStep[];
}

function key(label: string, kind?: 'literal'): HelpKey {
  return kind ? { label, kind } : { label };
}

export const HELP_EXAMPLES: HelpExampleData[] = [
  {
    title: 'The sweep',
    blurb: "The result's this simple. Nine keys, no detail entered at all.",
    keys: [key('/'), key('zain'), key('⏎'), key('−'), key('⏎'), key('⏎')],
    steps: [
      { upTo: 0, caption: 'Focus search.', preview: { search: { query: '', result: null } } },
      {
        upTo: 1,
        caption: 'Type the winner’s tag — <strong>zain</strong>.',
        preview: { search: { query: 'zain', result: { num: 1, names: 'Zain vs Wizzrobe' } } },
      },
      {
        upTo: 2,
        caption: 'Top result’s right — <strong>⏎</strong> opens it, already selected as winner.',
        preview: { names: { winner: 'Zain', loser: 'Wizzrobe' }, score: { w: 0, l: 0 } },
      },
      {
        upTo: 3,
        caption:
          '<strong>−</strong> — a clean sweep, sized to whatever Bo this is. (<strong>+</strong> or <strong>0</strong> works just as well — whichever feels natural.)',
        preview: { games: [{ r: 'w' }, { r: 'w' }, { r: 'w' }], score: { w: 3, l: 0 } },
      },
      { upTo: 4, caption: '<strong>⏎</strong> — asks to confirm.' },
      { upTo: 5, caption: '<strong>⏎</strong> again — reported.' },
    ],
  },
  {
    title: 'A real 3–1',
    blurb: "Per-game score plus a character for each side — the case you'll actually type most nights.",
    keys: [
      key('/'), key('wizz'), key('1'), key('1'), key('2'), key('4'),
      key('c'), key('w'), key('fox'), key('⏎'), key('l'), key('falco'), key('⏎'),
      key('⏎'), key('⏎'),
    ],
    steps: [
      { upTo: 0, caption: 'Focus search.', preview: { search: { query: '', result: null } } },
      {
        upTo: 1,
        caption: 'Type <strong>wizz</strong>.',
        preview: { search: { query: 'wizz', result: { num: 1, names: 'Wizzrobe vs Zain' } } },
      },
      {
        upTo: 2,
        caption: 'Not the top result this time — <strong>1</strong> jumps straight to the labeled match.',
        preview: { names: { winner: 'Wizzrobe', loser: 'Zain' }, score: { w: 0, l: 0 } },
      },
      {
        upTo: 3,
        caption: '<strong>1</strong> — a game on the board for the winner.',
        preview: { games: [{ r: 'w' }], score: { w: 1, l: 0 } },
      },
      {
        upTo: 4,
        caption: '<strong>2</strong> — and another.',
        preview: { games: [{ r: 'w' }, { r: 'w' }], score: { w: 2, l: 0 } },
      },
      {
        upTo: 5,
        caption: '<strong>4</strong> — that’s 3 wins for a Bo5. Game 3 falls in as the loss.',
        preview: { games: [{ r: 'w' }, { r: 'w' }, { r: 'l' }, { r: 'w' }], score: { w: 3, l: 1 } },
      },
      {
        upTo: 6,
        caption: '<strong>c</strong> — opens the character tool. Every box outlines while you pick a side.',
        preview: { focus: { pending: true } },
      },
      {
        upTo: 7,
        caption: '<strong>w</strong> — winner’s character, every game.',
        preview: { focus: { side: 'winner', target: 'all' } },
      },
      {
        upTo: 8,
        caption: 'Type <strong>fox</strong>.',
        preview: { focus: { side: 'winner', target: 'all' } },
      },
      {
        upTo: 9,
        caption: '<strong>⏎</strong> commits it to all four games.',
        preview: {
          games: [{ r: 'w', w: 'Fox' }, { r: 'w', w: 'Fox' }, { r: 'l', w: 'Fox' }, { r: 'w', w: 'Fox' }],
        },
      },
      {
        upTo: 10,
        caption: '<strong>l</strong> — switch to the loser’s character, still "all games".',
        preview: { focus: { side: 'loser', target: 'all' } },
      },
      {
        upTo: 11,
        caption: 'Type <strong>falco</strong>.',
        preview: { focus: { side: 'loser', target: 'all' } },
      },
      {
        upTo: 12,
        caption: '<strong>⏎</strong> commits it.',
        preview: {
          games: [
            { r: 'w', w: 'Fox', l: 'Falco' },
            { r: 'w', w: 'Fox', l: 'Falco' },
            { r: 'l', w: 'Fox', l: 'Falco' },
            { r: 'w', w: 'Fox', l: 'Falco' },
          ],
        },
      },
      { upTo: 13, caption: '<strong>⏎</strong> — asks to confirm.' },
      { upTo: 14, caption: '<strong>⏎</strong> again — reported.' },
    ],
  },
  {
    title: 'Mid-set character switch',
    blurb: 'Player counterpicked partway through. Target two specific games at once instead of retyping "all".',
    keys: [
      key('…', 'literal'), key('c'), key('w'), key('1'), key('3'),
      key('marth'), key('⏎'), key('⏎'), key('⏎'),
    ],
    steps: [
      {
        upTo: 0,
        caption:
          'Picking up from the 3–1 above — Fox and Falco are already locked in for every game (game 3 was the loss).',
        preview: {
          names: { winner: 'Wizzrobe', loser: 'Zain' },
          score: { w: 3, l: 1 },
          games: [
            { r: 'w', w: 'Fox', l: 'Falco' },
            { r: 'w', w: 'Fox', l: 'Falco' },
            { r: 'l', w: 'Fox', l: 'Falco' },
            { r: 'w', w: 'Fox', l: 'Falco' },
          ],
        },
      },
      { upTo: 1, caption: '<strong>c</strong> — opens the tool again.', preview: { focus: { pending: true } } },
      {
        upTo: 2,
        caption: '<strong>w</strong> — lands on "all games" again.',
        preview: { focus: { side: 'winner', target: 'all' } },
      },
      {
        upTo: 3,
        caption: '<strong>1</strong> — switches the target to just game 1.',
        preview: { focus: { side: 'winner', target: [1] } },
      },
      {
        upTo: 4,
        caption: '<strong>3</strong> — adds game 3, instead of replacing it. Both are targeted now.',
        preview: { focus: { side: 'winner', target: [1, 3] } },
      },
      {
        upTo: 5,
        caption: 'Type <strong>marth</strong>.',
        preview: { focus: { side: 'winner', target: [1, 3] } },
      },
      {
        upTo: 6,
        caption: '<strong>⏎</strong> — applies to games 1 <em>and</em> 3 only. Games 2 and 4 keep Fox.',
        preview: {
          games: [
            { r: 'w', w: 'Marth', l: 'Falco' },
            { r: 'w', w: 'Fox', l: 'Falco' },
            { r: 'l', w: 'Marth', l: 'Falco' },
            { r: 'w', w: 'Fox', l: 'Falco' },
          ],
        },
      },
      { upTo: 7, caption: '<strong>⏎</strong> — asks to confirm.' },
      { upTo: 8, caption: '<strong>⏎</strong> again — reported.' },
    ],
  },
  {
    title: 'Wrong winner selected',
    blurb: "You'd already typed the set when you realized the name on the left was backwards. One key, and only the names move.",
    keys: [
      key('…', 'literal'), key('1'), key('2'), key('4'), key('c'), key('w'), key('fox'), key('⏎'),
      key('f'),
    ],
    steps: [
      {
        upTo: 0,
        caption: 'Wizzrobe just won this set on stream. But the search matched Zain, so Zain’s on the left.',
        preview: { names: { winner: 'Zain', loser: 'Wizzrobe' }, score: { w: 0, l: 0 } },
      },
      {
        upTo: 1,
        caption: '<strong>1</strong> — a game down for whoever’s currently marked winner.',
        preview: { games: [{ r: 'w' }], score: { w: 1, l: 0 } },
      },
      {
        upTo: 2,
        caption: '<strong>2</strong> — and another.',
        preview: { games: [{ r: 'w' }, { r: 'w' }], score: { w: 2, l: 0 } },
      },
      {
        upTo: 3,
        caption: '<strong>4</strong> — typed the score anyway, from whoever’s currently marked winner.',
        preview: { games: [{ r: 'w' }, { r: 'w' }, { r: 'l' }, { r: 'w' }], score: { w: 3, l: 1 } },
      },
      { upTo: 4, caption: '<strong>c</strong> — opens the character tool.', preview: { focus: { pending: true } } },
      {
        upTo: 5,
        caption: '…then <strong>w</strong> — which already lands on "all games".',
        preview: { focus: { side: 'winner', target: 'all' } },
      },
      {
        upTo: 6,
        caption: 'Typed <strong>fox</strong>, still for whoever’s currently marked winner.',
        preview: { focus: { side: 'winner', target: 'all' } },
      },
      {
        upTo: 7,
        caption: '<strong>⏎</strong> commits it.',
        preview: {
          games: [{ r: 'w', w: 'Fox' }, { r: 'w', w: 'Fox' }, { r: 'l', w: 'Fox' }, { r: 'w', w: 'Fox' }],
        },
      },
      {
        upTo: 8,
        caption:
          '<strong>f</strong> — swaps only the two names. The games and Fox stay exactly where they were, now correctly Wizzrobe’s.',
        preview: { names: { winner: 'Wizzrobe', loser: 'Zain' } },
      },
    ],
  },
];

export const HELP_MAX_ROWS = 5;
export const HELP_REQUIRED_WINS = 3;
