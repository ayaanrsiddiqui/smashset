import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { eventRouter } from './routes/event.js';
import { setsRouter } from './routes/sets.js';
import { charactersRouter } from './routes/characters.js';
import { stagesRouter } from './routes/stages.js';
import { reportRouter } from './routes/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/config', (_req, res) => {
  res.json({ hasApiKey: Boolean(process.env.STARTGG_API_KEY) });
});

app.use('/api/event', eventRouter);
app.use('/api/sets', setsRouter);
app.use('/api/characters', charactersRouter);
app.use('/api/stages', stagesRouter);
app.use('/api/report', reportRouter);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => {
  console.log(`quickset server listening on http://localhost:${PORT}`);
});
