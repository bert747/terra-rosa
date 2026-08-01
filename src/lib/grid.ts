import type { ISODate } from "@/lib/occupancy";
import { bedCapacity } from "@/lib/bed-types";

// ---------------------------------------------------------------------------
// Time-aware grid layout.
//
// The grid is built fresh for whatever [dates[0], dates[last]] window is
// being viewed: bed placements and joins are resolved as of THOSE dates, not
// "current" state. A bed whose bed_locations row only starts in September
// contributes nothing when viewing July — no ghost rows.
//
// Row model: one row per (bed, room) placement segment. A bed that moved
// rooms mid-window gets a row in EACH room it occupied, each active only for
// its own sub-range — cells outside a row's active range render as
// "inactive" rather than bookable, which is how a row visually "sprouts" or
// "collapses" partway across the date columns without breaking the table's
// fixed row/column structure.
//
// A join never changes ROW STRUCTURE — a join's date range can start or end
// mid-window, and a table row (or its left-hand label) can't vary by column,
// so both beds always keep their own row and their own "Single" label. What
// DOES vary per date, safely, is the per-column table CELLS: each `<td>` in
// a row can carry its own `rowSpan` independent of its neighbours, so the UI
// (see GridCanvas.tsx) can, on a cell-by-cell basis:
//   - "double" mode: leave both cells as normal 1-row cells and draw a
//     single chain icon bridging the border between them.
//   - "solo" mode: rowSpan the primary bed's cell down over the secondary
//     bed's cell for that exact date, showing one merged "Solo Double" spot
//     — the secondary bed's row simply omits its own cell there.
// `joinBadge` on each cell (below) carries everything that per-date decision
// needs: partner, mode, and which bed is primary.
// ---------------------------------------------------------------------------

export interface GridBooking {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  /** Exclusive: the guest's last night is the day before this date. */
  departureDate: ISODate;
  groupId: string | null;
  bedId: number;
}

export interface GridBedInfo {
  bedId: number;
  type: string;
}

/** One stint a bed spent in a room, straight from bed_locations. */
export interface BedLocationSegment {
  bedId: number;
  roomId: number;
  startDate: ISODate;
  /** null = open-ended (still there as of the query, or forever). */
  endDate: ISODate | null;
}

/** One stint two beds were joined, straight from joined_beds. */
export interface JoinSegment {
  bed1Id: number;
  bed2Id: number;
  startDate: ISODate;
  endDate: ISODate | null;
  mode: "double" | "solo";
}

export interface JoinBadge {
  partnerBedId: number;
  mode: "double" | "solo";
  /** bed1 in the join row — the bookable one when mode is "solo". */
  isPrimary: boolean;
}

export interface SlotCell {
  state: "inactive" | "free" | "booked";
  booking?: GridBooking;
  isArrival?: boolean;
  isDeparture?: boolean;
  /** True on a "free" cell that's the non-bookable half of a Solo Double. */
  blockedBySoloJoin?: boolean;
  joinBadge?: JoinBadge | null;
}

export interface UnitSlot {
  cells: SlotCell[];
}

export interface GridUnit {
  /** React key: "<bedId>:<roomId>" — a bed that moved rooms gets one unit per room. */
  key: string;
  bedId: number;
  label: string;
  slots: UnitSlot[];
  /**
   * Key of the immediately-adjacent unit this one is joined with somewhere
   * in the viewed window, if any (see reorderJoinedPairs) — set on BOTH
   * units of a pair. The renderer uses this to render the pair's two rows
   * together so it can rowSpan/skip cells per date; the exact per-date
   * behaviour still comes from each cell's own `joinBadge`, not from this.
   */
  partnerUnitKey?: string;
}

export interface RoomGridRow {
  roomId: number;
  roomName: string;
  floorId: number;
  floorName: string;
  units: GridUnit[];
}

export interface CapacityByDate {
  occupied: number[];
  total: number[];
}

function nextDayLocal(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function coversDate(startDate: ISODate, endDate: ISODate | null, date: ISODate): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

/** Packs a bed's bookings onto `slotCount` parallel slots, one booking per slot per active night. */
function packBookingsIntoSlots(
  dates: ISODate[],
  active: boolean[],
  bookings: GridBooking[],
  slotCount: number
): SlotCell[][] {
  const slots: SlotCell[][] = Array.from({ length: slotCount }, () =>
    dates.map((_, i) => ({ state: active[i] ? "free" : "inactive" }) as SlotCell)
  );

  const ordered = [...bookings].sort(
    (a, b) => a.arrivalDate.localeCompare(b.arrivalDate) || a.id - b.id
  );

  for (const booking of ordered) {
    const dateIndexes: number[] = [];
    dates.forEach((d, i) => {
      if (active[i] && booking.arrivalDate <= d && booking.departureDate > d) dateIndexes.push(i);
    });
    if (dateIndexes.length === 0) continue;

    const isFree = (slotIndex: number) =>
      slotIndex < slots.length && dateIndexes.every((i) => slots[slotIndex][i].state !== "booked");

    let slotIndex = 0;
    while (!isFree(slotIndex)) {
      slotIndex++;
      // Overflow beyond configured capacity — extend rather than drop the booking.
      if (slotIndex >= slots.length) {
        slots.push(dates.map((_, i) => ({ state: active[i] ? "free" : "inactive" }) as SlotCell));
      }
    }
    for (const i of dateIndexes) {
      slots[slotIndex][i] = {
        state: "booked",
        booking,
        isArrival: booking.arrivalDate === dates[i],
        isDeparture: nextDayLocal(dates[i]) === booking.departureDate,
      };
    }
  }

  return slots;
}

function windowOverlaps(seg: { startDate: ISODate; endDate: ISODate | null }, windowStart: ISODate, windowEndExclusive: ISODate): boolean {
  return seg.startDate < windowEndExclusive && (seg.endDate == null || seg.endDate > windowStart);
}

/**
 * Reorders a room's units so any pair that's joined anywhere in the viewed
 * window sits adjacent, and marks both with `partnerUnitKey` — required for
 * the renderer to treat them as one 2-row block (see the module doc above).
 * This only decides ADJACENCY/pairing for the block; it does not decide
 * merge-vs-separate for any given date column — that's each cell's own
 * `joinBadge`, checked independently per date by the renderer.
 */
function reorderJoinedPairs(units: GridUnit[], joinSegments: JoinSegment[], windowStart: ISODate, windowEndExclusive: ISODate): GridUnit[] {
  const pairedBedIds = new Set<number>();
  for (const seg of joinSegments) {
    if (!windowOverlaps(seg, windowStart, windowEndExclusive)) continue;
    pairedBedIds.add(seg.bed1Id);
    pairedBedIds.add(seg.bed2Id);
  }
  if (pairedBedIds.size === 0) return units;

  const partnerOf = new Map<number, number>();
  for (const seg of joinSegments) {
    if (!windowOverlaps(seg, windowStart, windowEndExclusive)) continue;
    partnerOf.set(seg.bed1Id, seg.bed2Id);
    partnerOf.set(seg.bed2Id, seg.bed1Id);
  }

  const byBedId = new Map(units.map((u) => [u.bedId, u]));
  const placed = new Set<string>();
  const result: GridUnit[] = [];

  for (const unit of units) {
    if (placed.has(unit.key)) continue;

    const partnerBedId = partnerOf.get(unit.bedId);
    const partner = partnerBedId != null ? byBedId.get(partnerBedId) : undefined;

    placed.add(unit.key);
    if (partner && !placed.has(partner.key)) {
      placed.add(partner.key);
      result.push({ ...unit, partnerUnitKey: partner.key });
      result.push({ ...partner, partnerUnitKey: unit.key });
    } else {
      result.push(unit);
    }
  }

  return result;
}

/** Builds the full time-aware grid for the given date window. */
export function buildRoomGrid(
  dates: ISODate[],
  rooms: Array<{ id: number; name: string; floorId: number; floorName: string }>,
  bedInfos: GridBedInfo[],
  locationSegments: BedLocationSegment[],
  joinSegments: JoinSegment[],
  bookings: GridBooking[]
): RoomGridRow[] {
  const bedTypeById = new Map(bedInfos.map((b) => [b.bedId, b.type]));

  // (bedId, roomId) -> active[dateIndex]
  const activeByBedRoom = new Map<string, boolean[]>();
  // bedId -> roomId per date index (for join co-location checks)
  const roomByBedDate = new Map<number, (number | null)[]>();

  for (const seg of locationSegments) {
    const key = `${seg.bedId}:${seg.roomId}`;
    const active = activeByBedRoom.get(key) ?? new Array(dates.length).fill(false);
    const roomTrack = roomByBedDate.get(seg.bedId) ?? new Array(dates.length).fill(null);
    dates.forEach((d, i) => {
      if (coversDate(seg.startDate, seg.endDate, d)) {
        active[i] = true;
        roomTrack[i] = seg.roomId;
      }
    });
    activeByBedRoom.set(key, active);
    roomByBedDate.set(seg.bedId, roomTrack);
  }

  // bedId -> JoinBadge|null per date index
  const joinStatusByBed = new Map<number, (JoinBadge | null)[]>();
  const setJoinStatus = (bedId: number, index: number, badge: JoinBadge) => {
    const arr = joinStatusByBed.get(bedId) ?? new Array(dates.length).fill(null);
    arr[index] = badge;
    joinStatusByBed.set(bedId, arr);
  };

  for (const seg of joinSegments) {
    dates.forEach((d, i) => {
      if (!coversDate(seg.startDate, seg.endDate, d)) return;
      const room1 = roomByBedDate.get(seg.bed1Id)?.[i] ?? null;
      const room2 = roomByBedDate.get(seg.bed2Id)?.[i] ?? null;
      if (room1 == null || room1 !== room2) return; // not co-located — ignore for this date
      setJoinStatus(seg.bed1Id, i, { partnerBedId: seg.bed2Id, mode: seg.mode, isPrimary: true });
      setJoinStatus(seg.bed2Id, i, { partnerBedId: seg.bed1Id, mode: seg.mode, isPrimary: false });
    });
  }

  const bookingsByBed = new Map<number, GridBooking[]>();
  for (const booking of bookings) {
    const list = bookingsByBed.get(booking.bedId);
    if (list) list.push(booking);
    else bookingsByBed.set(booking.bedId, [booking]);
  }

  const unitsByRoom = new Map<number, GridUnit[]>();

  for (const [key, active] of activeByBedRoom) {
    if (!active.some(Boolean)) continue;
    const [bedIdStr, roomIdStr] = key.split(":");
    const bedId = Number(bedIdStr);
    const roomId = Number(roomIdStr);
    const type = bedTypeById.get(bedId) ?? "Single";
    const capacity = bedCapacity(type);
    const joinStatus = joinStatusByBed.get(bedId);

    const slotCells = packBookingsIntoSlots(dates, active, bookingsByBed.get(bedId) ?? [], capacity);

    if (joinStatus) {
      // Only the single-capacity slot (index 0) can be a joined bed.
      dates.forEach((_, i) => {
        const badge = joinStatus[i];
        if (!badge) return;
        const cell = slotCells[0][i];
        cell.joinBadge = badge;
        if (badge.mode === "solo" && !badge.isPrimary && cell.state === "free") {
          cell.blockedBySoloJoin = true;
        }
      });
    }

    const unit: GridUnit = {
      key,
      bedId,
      label: type,
      slots: slotCells.map((cells) => ({ cells })),
    };

    const list = unitsByRoom.get(roomId);
    if (list) list.push(unit);
    else unitsByRoom.set(roomId, [unit]);
  }

  const windowStart = dates[0];
  const windowEndExclusive = dates.length > 0 ? nextDayLocal(dates[dates.length - 1]) : dates[0];

  return rooms
    .filter((room) => (unitsByRoom.get(room.id)?.length ?? 0) > 0)
    .map((room) => ({
      roomId: room.id,
      roomName: room.name,
      floorId: room.floorId,
      floorName: room.floorName,
      units:
        dates.length > 0
          ? reorderJoinedPairs(unitsByRoom.get(room.id) ?? [], joinSegments, windowStart, windowEndExclusive)
          : unitsByRoom.get(room.id) ?? [],
    }));
}

/** Property-wide occupied/total capacity per date, across every room in the grid. */
export function capacityByDate(dates: ISODate[], grid: RoomGridRow[]): CapacityByDate {
  const occupied = dates.map(() => 0);
  const total = dates.map(() => 0);

  for (const room of grid) {
    for (const unit of room.units) {
      for (const slot of unit.slots) {
        dates.forEach((_, i) => {
          const cell = slot.cells[i];
          if (cell.state === "inactive") return;
          if (cell.blockedBySoloJoin) return;
          total[i] += 1;
          if (cell.state === "booked") occupied[i] += 1;
        });
      }
    }
  }

  return { occupied, total };
}
