import './env.js';
import { createApp } from './app.js';

const app = createApp();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => {
  console.log(`SmashSet server listening on http://localhost:${PORT}`);
});
