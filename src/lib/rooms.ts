import type { Room } from "@/db/schema";

// ---------------------------------------------------------------------------
// Room ordering: primarily the manually-set `rank` (drag-to-reorder in
// Layout settings — see rooms.rank's own schema comment), falling back to
// natural, numeric-aware name order ("Monk 2" before "Monk 10") whenever two
// rooms tie on rank — which is every room until someone actually drags a
// row, since rank defaults to 0 for all of them.
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural ("human") comparison of two room names: Monk 2 sorts before Monk 10. */
export function compareRoomNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Returns a new array of rooms in rank order, tiebroken by natural name order. */
export function sortRooms<T extends { name: string; rank?: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || compareRoomNames(a.name, b.name));
}

export type { Room };
