import { Router } from 'express';
import { gql, parseStartggInput, resolveShortUrl } from '../startgg.js';

export const eventRouter = Router();

interface EventInfo {
  id: number;
  name: string;
  slug: string;
  videogame: { id: number; name: string };
  tournament: { id: number; name: string };
}

interface EventQueryResult {
  event: Omit<EventInfo, 'tournament'> & { tournament: { id: number; name: string } } | null;
}

interface TournamentQueryResult {
  tournament: {
    id: number;
    name: string;
    events: (Omit<EventInfo, 'tournament'>)[] | null;
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

const TOURNAMENT_QUERY = /* GraphQL */ `
  query ResolveTournament($slug: String!) {
    tournament(slug: $slug) {
      id
      name
      events {
        id
        name
        slug
        videogame {
          id
          name
        }
      }
    }
  }
`;

eventRouter.post('/resolve', async (req, res) => {
  const input = req.body?.input;
  if (typeof input !== 'string' || !input.trim()) {
    res.status(400).json({ error: 'Provide a start.gg event or tournament URL/slug' });
    return;
  }

  const parsed = parseStartggInput(input);
  const accessToken = req.user!.accessToken;

  try {
    if (parsed.type === 'event') {
      const data = await gql<EventQueryResult>(accessToken, EVENT_QUERY, { slug: parsed.slug });
      if (!data.event) {
        res.status(404).json({ error: `No event found for "${parsed.slug}"` });
        return;
      }
      res.json({ event: data.event });
      return;
    }

    // A bare slug is whatever start.gg/<slug> serves, which is not always what
    // tournament(slug:) returns for the same string; see resolveShortUrl.
    const slug = (parsed.bare && (await resolveShortUrl(parsed.slug))) || parsed.slug;

    const data = await gql<TournamentQueryResult>(accessToken, TOURNAMENT_QUERY, { slug });
    if (!data.tournament) {
      res.status(404).json({ error: `No tournament found for "${parsed.slug}"` });
      return;
    }

    const events = data.tournament.events ?? [];
    if (events.length === 0) {
      res.status(404).json({ error: `"${data.tournament.name}" has no events` });
      return;
    }

    if (events.length === 1) {
      const e = events[0];
      res.json({ event: { ...e, tournament: { id: data.tournament.id, name: data.tournament.name } } });
      return;
    }

    // Multiple events under this tournament — let the client pick one.
    res.json({
      events: events.map((e) => ({
        ...e,
        tournament: { id: data.tournament!.id, name: data.tournament!.name },
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to resolve event' });
  }
});
