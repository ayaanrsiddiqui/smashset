export interface EntrantInfo {
  id: number;
  name: string;
}

export interface OpenSet {
  id: number | string;
  isPreview: boolean;
  fullRoundText: string;
  identifier: string;
  entrants: EntrantInfo[];
}

export interface Character {
  id: number;
  name: string;
}

export interface EventInfo {
  id: number;
  name: string;
  slug: string;
  videogame: { id: number; name: string };
  tournament: { id: number; name: string };
}
