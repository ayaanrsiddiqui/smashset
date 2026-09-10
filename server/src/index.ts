import './env.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';

await runMigrations();

const app = createApp();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => {
  console.log(`SmashSet server listening on http://localhost:${PORT}`);
});
