import { Router } from 'express';
import { gql } from '../startgg.js';

export const stagesRouter = Router();

interface StagesQueryResult {
  videogame: {
    id: number;
    stages: { id: number; name: string }[] | null;
  } | null;
}

const STAGES_QUERY = /* GraphQL */ `
  query VideogameStages($videogameId: ID!) {
    videogame(id: $videogameId) {
      id
      stages {
        id
        name
      }
    }
  }
`;

const cache = new Map<string, { id: number; name: string }[]>();

stagesRouter.get('/:videogameId', async (req, res) => {
  const { videogameId } = req.params;

  const cached = cache.get(videogameId);
  if (cached) {
    res.json({ stages: cached });
    return;
  }

  try {
    const data = await gql<StagesQueryResult>(STAGES_QUERY, { videogameId });
    const stages = data.videogame?.stages ?? [];
    cache.set(videogameId, stages);
    res.json({ stages });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load stages' });
  }
});
