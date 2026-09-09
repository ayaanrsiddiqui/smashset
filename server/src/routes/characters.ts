import { Router } from 'express';
import { gql } from '../startgg.js';

export const charactersRouter = Router();

interface RawImage {
  url: string;
  width: number | null;
  height: number | null;
}

interface RawCharacter {
  id: number;
  name: string;
  images: RawImage[] | null;
}

interface CharactersQueryResult {
  videogame: {
    id: number;
    characters: RawCharacter[] | null;
  } | null;
}

interface Character {
  id: number;
  name: string;
  imageUrl?: string;
}

const CHARACTERS_QUERY = /* GraphQL */ `
  query VideogameCharacters($videogameId: ID!) {
    videogame(id: $videogameId) {
      id
      characters {
        id
        name
        images {
          url
          width
          height
        }
      }
    }
  }
`;

/** Smallest image by area — good enough as a compact inline icon regardless of what sizes a game's art has. */
function pickIconUrl(images: RawImage[] | null): string | undefined {
  if (!images || images.length === 0) return undefined;
  let best = images[0];
  let bestArea = (best.width ?? Infinity) * (best.height ?? Infinity);
  for (const img of images.slice(1)) {
    const area = (img.width ?? Infinity) * (img.height ?? Infinity);
    if (area < bestArea) {
      best = img;
      bestArea = area;
    }
  }
  return best.url;
}

const cache = new Map<string, Character[]>();

charactersRouter.get('/:videogameId', async (req, res) => {
  const { videogameId } = req.params;

  const cached = cache.get(videogameId);
  if (cached) {
    res.json({ characters: cached });
    return;
  }

  try {
    const data = await gql<CharactersQueryResult>(req.user!.accessToken, CHARACTERS_QUERY, { videogameId });
    const characters = (data.videogame?.characters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      imageUrl: pickIconUrl(c.images),
    }));
    cache.set(videogameId, characters);
    res.json({ characters });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to load characters' });
  }
});
