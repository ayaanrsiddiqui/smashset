import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { accountRouter } from './routes/account.js';
import { eventRouter } from './routes/event.js';
import { setsRouter } from './routes/sets.js';
import { charactersRouter } from './routes/characters.js';
import { stagesRouter } from './routes/stages.js';
import { reportRouter } from './routes/report.js';
import { mainsRouter } from './routes/mains.js';
import { clientEventsRouter } from './routes/clientEvents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Split out from index.ts so tests can exercise the real routing/middleware
// stack (via supertest) without binding a port or running migrations —
// those are index.ts's job at actual boot time.
export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Railway terminates TLS at a proxy in front of this process
  app.use(express.json());
  app.use(cookieParser(process.env.SESSION_SECRET));

  // No `cors` here, deliberately — the browser never makes a cross-origin
  // request in either environment. In dev, Vite proxies /api (the browser
  // only ever talks to :5173, browser-to-:3001 is server-to-server and not
  // subject to CORS at all); in prod, this same process serves the built
  // frontend too (below), so it's same-origin. A wide-open cors() also can't
  // be paired with the credentialed (cookie) requests introduced here.
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  // No requireAuth, deliberately — see the note in the router. A signed-out
  // browser is one of the things this exists to tell us about.
  app.use('/api/client-events', clientEventsRouter);
  app.use('/api/account', requireAuth, accountRouter);
  app.use('/api/event', requireAuth, eventRouter);
  app.use('/api/sets', requireAuth, setsRouter);
  app.use('/api/characters', requireAuth, charactersRouter);
  app.use('/api/stages', requireAuth, stagesRouter);
  app.use('/api/report', requireAuth, reportRouter);
  app.use('/api/mains', requireAuth, mainsRouter);

  if (process.env.NODE_ENV === 'production') {
    // Railway does not set NODE_ENV=production automatically — it's set
    // explicitly as a service variable. No catch-all route needed on top of
    // this: there's no client-side router, so express.static's default
    // index.html-at-"/" already covers the only route that exists.
    app.use(express.static(path.resolve(__dirname, '../../web/dist')));
  }

  // Last: anything a route threw without handling. Without this Express
  // answers with an HTML stack trace, which the client cannot parse and which
  // leaks internals outside production.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[unhandled]', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong on our end. Try again.' });
  });

  return app;
}
