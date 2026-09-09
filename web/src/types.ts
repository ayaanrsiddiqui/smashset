export interface EntrantInfo {
  id: number;
  name: string;
  suggestedMainCharacterId?: number;
}

export interface OpenSet {
  id: number | string;
  isPreview: boolean;
  isStarted: boolean;
  fullRoundText: string;
  identifier: string;
  lPlacement: number | null;
  entrants: EntrantInfo[];
}

export interface Character {
  id: number;
  name: string;
  imageUrl?: string;
}

export interface Stage {
  id: number;
  name: string;
}

export interface CurrentUser {
  id: number;
  displayName: string;
}

export interface EventInfo {
  id: number;
  name: string;
  slug: string;
  videogame: { id: number; name: string };
  tournament: { id: number; name: string };
}
