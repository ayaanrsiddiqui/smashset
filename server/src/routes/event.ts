import { Router } from 'express';
import { gql, normalizeEventSlug } from '../startgg.js';

export const eventRouter = Router();

interface EventQueryResult {
  event: {
    id: number;
    name: string;
    slug: string;
    videogame: { id: number; name: string };
    tournament: { id: number; name: string };
  } | null;
}

const EVENT_QUERY = /* GraphQL */ `
  query ResolveEvent($slug: String!) {
    event(slug: $slug) {
      id
      name
      slug
      videogame {
        id
        name
      }
      tournament {
        id
        name
      }
    }
  }
`;

eventRouter.post('/resolve', async (req, res) => {
  const input = req.body?.input;
  if (typeof input !== 'string' || !input.trim()) {
    res.status(400).json({ error: 'Provide a start.gg event URL or slug' });
    return;
  }

  const slug = normalizeEventSlug(input);

  try {
    const data = await gql<EventQueryResult>(EVENT_QUERY, { slug });
    if (!data.event) {
      res.status(404).json({ error: `No event found for "${slug}"` });
      return;
    }
    res.json({ event: data.event });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to resolve event' });
  }
});
