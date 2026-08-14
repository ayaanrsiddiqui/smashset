import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const EVENT = {
  id: 1001,
  name: 'Melee Singles',
  slug: 'tournament/quickset-test/event/melee-singles',
  videogame: { id: 1, name: 'Super Smash Bros. Melee' },
  tournament: { id: 1, name: 'quickset test' },
};

const SETS = [
  {
    id: 5001,
    isPreview: false,
    fullRoundText: 'Winners Round 1',
    identifier: 'A1',
    entrants: [
      { id: 1, name: 'Zain' },
      { id: 2, name: 'Moky' },
    ],
  },
  {
    id: 5002,
    isPreview: false,
    fullRoundText: 'Winners Round 1',
    identifier: 'A2',
    entrants: [
      { id: 3, name: 'Zamu' },
      { id: 4, name: 'Zackray' },
    ],
  },
  {
    id: 5003,
    isPreview: false,
    fullRoundText: 'Losers Round 3',
    identifier: 'B3',
    entrants: [
      { id: 5, name: 'aMSa' },
      { id: 6, name: 'Zoso' },
    ],
  },
  {
    id: 5004,
    isPreview: false,
    fullRoundText: 'Grand Final',
    identifier: 'GF',
    entrants: [
      { id: 7, name: 'Wizzrobe' },
      { id: 8, name: 'Zain' },
    ],
  },
  {
    id: 'preview_9001',
    isPreview: true,
    fullRoundText: 'Winners Round 2',
    identifier: 'A5',
    entrants: [
      { id: 9, name: 'n0ne' },
      { id: 10, name: 'Ginger' },
    ],
  },
];

const CHARACTERS = [
  'Fox', 'Falco', 'Marth', 'Sheik', 'Jigglypuff', 'Captain Falcon', 'Peach',
  'Ice Climbers', 'Samus', 'Dr. Mario', 'Ganondorf', 'Sonic', 'Link',
].map((name, i) => ({ id: i + 1, name }));

const STAGES = [
  'Battlefield', "Yoshi's Story", 'Final Destination', 'Dream Land N64',
  'Fountain of Dreams', 'Pokemon Stadium',
].map((name, i) => ({ id: i + 1, name }));

app.get('/api/config', (_req, res) => res.json({ hasApiKey: true }));

app.post('/api/event/resolve', (req, res) => {
  console.log('[mock] resolve', req.body);
  res.json({ event: EVENT });
});

app.get('/api/sets/:eventId/open-sets', (_req, res) => {
  res.json({ sets: SETS });
});

app.get('/api/characters/:videogameId', (_req, res) => {
  res.json({ characters: CHARACTERS });
});

app.get('/api/stages/:videogameId', (_req, res) => {
  res.json({ stages: STAGES });
});

app.post('/api/report', (req, res) => {
  console.log('[mock] REPORT PAYLOAD', JSON.stringify(req.body, null, 2));
  res.json({ result: { ok: true }, games: [] });
});

app.listen(3001, () => console.log('mock quickset server on :3001'));
