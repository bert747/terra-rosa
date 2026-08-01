import type { Room } from "@/db/schema";

// ---------------------------------------------------------------------------
// Natural room-name ordering: room names are text ("Monk 2", "Monk 10"), so a
// plain ORDER BY name sorts them lexicographically. Every room list in the
// app should read 1, 2, 3, ... 10 instead, so ordering uses a numeric-aware
// collator.
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural ("human") comparison of two room names: Monk 2 sorts before Monk 10. */
export function compareRoomNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Returns a new array of rooms in natural name order. */
export function sortRooms<T extends { name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => compareRoomNames(a.name, b.name));
}

export type { Room };
