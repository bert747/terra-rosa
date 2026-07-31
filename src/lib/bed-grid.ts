import type { ISODate, SegmentWithGuest } from "@/lib/occupancy";
import { nextDay } from "@/lib/occupancy";

// ---------------------------------------------------------------------------
// Bed-level grid layout.
//
// The data model allocates guests to ROOMS, not to individual beds (see the
// note at the top of src/db/schema.ts). The grid still needs one row per bed
// so staff can see, at a glance, that bed 1 of a room is taken on a night
// while bed 2 is free — the same way the paper/spreadsheet chart works.
//
// So bed rows are DERIVED here, deterministically:
//
//   * A room shows as many rows as its largest bed count in the window
//     (capacity can change per date via room_capacity_overrides).
//   * Segments are laid out in a fixed order (earliest start, then id) and
//     each one takes the lowest-numbered bed(s) that are free for every night
//     it covers. A party of N takes N beds.
//   * Because the order is fixed, a guest keeps the same bed row across all
//     the nights of their stay, and across page loads.
//   * If a room is over capacity the extra guests get overflow rows below the
//     real beds, flagged so the grid can highlight them.
//
// The bed numbers are a presentation device, not a booking of a specific
// physical bed — nothing here is persisted.
// ---------------------------------------------------------------------------

export interface BedCell {
  segment: SegmentWithGuest;
  /** This date is the segment's first night. */
  isArrival: boolean;
  /** This date is the segment's last night (they check out the next morning). */
  isDeparture: boolean;
}

export interface BedRow {
  /** 1-based bed number shown in the row label. */
  bedNumber: number;
  /** True when this row is beyond the room's bed count on every date. */
  isOverflow: boolean;
  /** One entry per date in the window; null means the bed is free that night. */
  cells: (BedCell | null)[];
}

export interface RoomGridRow {
  roomId: number;
  roomName: string;
  locationOrType: string | null;
  /** Effective bed count per date, index-aligned with the window's dates. */
  capacityByDate: number[];
  /** Occupied guest count per date, index-aligned with the window's dates. */
  occupancyByDate: number[];
  beds: BedRow[];
}

/**
 * Lays out one room's segments onto bed rows for the given dates.
 *
 * `segments` must all belong to the room; segments that don't overlap the
 * window are ignored.
 */
export function allocateBeds(
  dates: ISODate[],
  capacityByDate: number[],
  segments: SegmentWithGuest[]
): BedRow[] {
  // bedIndex -> dateIndex -> cell. Sparse: a missing entry means free.
  const beds: Array<Array<BedCell | null>> = [];

  const bedIsFree = (bedIndex: number, dateIndexes: number[]): boolean => {
    const bed = beds[bedIndex];
    if (!bed) return true;
    return dateIndexes.every((i) => bed[i] == null);
  };

  const ensureBed = (bedIndex: number): Array<BedCell | null> => {
    while (beds.length <= bedIndex) beds.push(new Array(dates.length).fill(null));
    return beds[bedIndex];
  };

  // Fixed order so bed assignment is stable between renders.
  const ordered = [...segments].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id
  );

  for (const segment of ordered) {
    const dateIndexes: number[] = [];
    dates.forEach((d, i) => {
      if (segment.startDate <= d && segment.endDate > d) dateIndexes.push(i);
    });
    if (dateIndexes.length === 0) continue;

    // A party of N occupies N beds for the whole segment.
    const bedsNeeded = Math.max(1, segment.guestCount);
    for (let n = 0; n < bedsNeeded; n++) {
      let bedIndex = 0;
      // Preferred bed is 1-based in persisted data.
      if (n === 0 && segment.preferredBed && segment.preferredBed > 0) {
        const preferredIndex = segment.preferredBed - 1;
        if (bedIsFree(preferredIndex, dateIndexes)) {
          bedIndex = preferredIndex;
        } else {
          while (!bedIsFree(bedIndex, dateIndexes)) bedIndex++;
        }
      } else {
        while (!bedIsFree(bedIndex, dateIndexes)) bedIndex++;
      }
      const bed = ensureBed(bedIndex);
      for (const i of dateIndexes) {
        bed[i] = {
          segment,
          isArrival: segment.startDate === dates[i],
          isDeparture: segment.endDate === nextDay(dates[i]),
        };
      }
    }
  }

  const maxCapacity = capacityByDate.length ? Math.max(...capacityByDate) : 0;
  // Always show every real bed, plus any overflow rows the guests forced.
  const rowCount = Math.max(maxCapacity, beds.length);
  const rows: BedRow[] = [];
  for (let bedIndex = 0; bedIndex < rowCount; bedIndex++) {
    rows.push({
      bedNumber: bedIndex + 1,
      isOverflow: bedIndex >= maxCapacity,
      cells: beds[bedIndex] ?? new Array(dates.length).fill(null),
    });
  }
  return rows;
}

/** True when this bed doesn't exist in the room on that date (capacity override). */
export function bedUnavailable(bedNumber: number, capacityOnDate: number): boolean {
  return bedNumber > capacityOnDate;
}

/** Builds the full grid: one RoomGridRow per room, in the order given. */
export function buildRoomGrid(
  dates: ISODate[],
  roomList: Array<{ id: number; name: string; locationOrType: string | null }>,
  capacities: Map<number, number[]>,
  segments: SegmentWithGuest[]
): RoomGridRow[] {
  const byRoom = new Map<number, SegmentWithGuest[]>();
  for (const segment of segments) {
    const list = byRoom.get(segment.roomId);
    if (list) list.push(segment);
    else byRoom.set(segment.roomId, [segment]);
  }

  return roomList.map((room) => {
    const capacityByDate = capacities.get(room.id) ?? dates.map(() => 0);
    const roomSegments = byRoom.get(room.id) ?? [];
    const beds = allocateBeds(dates, capacityByDate, roomSegments);

    const occupancyByDate = dates.map(
      (_, i) => beds.filter((bed) => bed.cells[i] != null).length
    );

    return {
      roomId: room.id,
      roomName: room.name,
      locationOrType: room.locationOrType,
      capacityByDate,
      occupancyByDate,
      beds,
    };
  });
}
