import { Router } from 'express';
import { gql } from '../startgg.js';

export const charactersRouter = Router();

interface CharactersQueryResult {
  videogame: {
    id: number;
    characters: { id: number; name: string }[] | null;
  } | null;
}

const CHARACTERS_QUERY = /* GraphQL */ `
  query VideogameCharacters($videogameId: ID!) {
    videogame(id: $videogameId) {
      id
      characters {
        id
        name
      }
    }
  }
`;

const cache = new Map<string, { id: number; name: string }[]>();

charactersRouter.get('/:videogameId', async (req, res) => {
  const { videogameId } = req.params;

  const cached = cache.get(videogameId);
  if (cached) {
    res.json({ characters: cached });
    return;
  }

  try {
    const data = await gql<CharactersQueryResult>(CHARACTERS_QUERY, { videogameId });
    const characters = data.videogame?.characters ?? [];
    cache.set(videogameId, characters);
    res.json({ characters });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load characters' });
  }
});
