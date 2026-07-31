import type { Room } from "@/db/schema";

// ---------------------------------------------------------------------------
// Room ordering.
//
// Two problems, both solved here rather than in SQL:
//
// 1. Room names are text ("Monk 2", "Monk 10"), so a plain ORDER BY name sorts
//    them lexicographically: Monk 1, Monk 10, Monk 2... Every room list in the
//    app should read 1, 2, 3, ... 10 instead, so ordering uses a numeric-aware
//    collator.
//
// 2. Rooms belong to areas of the house, and the grid is far easier to read
//    when it lists them the way the original spreadsheet does — the whole of
//    the 1st floor, then floor 2, then the monk cells, then outside, then
//    permanent staff — instead of alphabetically interleaving Ashram Room,
//    Back Room, Bunker, Camping. So rooms sort by area first, name second.
//
// Areas not in GROUP_ORDER (anything added later via the Rooms page) sort
// after the known ones, alphabetically, so a new area appears in a predictable
// place instead of at the top.
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** House areas in the order the occupancy spreadsheet lists them. */
const GROUP_ORDER = [
  "1st Floor",
  "Floor 2",
  "Monks",
  "Outside",
  "Guardians",
  "Residents",
  "Workers",
];

/** Natural ("human") comparison of two room names: Monk 2 sorts before Monk 10. */
export function compareRoomNames(a: string, b: string): number {
  return collator.compare(a, b);
}

interface Sortable {
  name: string;
  locationOrType?: string | null;
  displayOrder?: number | null;
}

function groupRank(group: string | null | undefined): number {
  if (!group) return GROUP_ORDER.length + 1; // ungrouped rooms last
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

/** Returns a new array of rooms in area order, then natural name order. */
export function sortRooms<T extends Sortable>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const aOrder = a.displayOrder ?? Number.POSITIVE_INFINITY;
    const bOrder = b.displayOrder ?? Number.POSITIVE_INFINITY;
    if (aOrder !== bOrder) return aOrder - bOrder;

    const rankDiff = groupRank(a.locationOrType) - groupRank(b.locationOrType);
    if (rankDiff !== 0) return rankDiff;
    // Same rank but different names (both unknown areas): order those by area
    // name so they at least stay grouped together.
    const groupDiff = collator.compare(a.locationOrType ?? "", b.locationOrType ?? "");
    if (groupDiff !== 0) return groupDiff;
    return compareRoomNames(a.name, b.name);
  });
}

export type { Room };
