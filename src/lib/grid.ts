import type { ISODate } from "@/lib/occupancy";

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

/** One stint a native two-person bed (Queen/1.5/Double) was sold solo, straight from bed_solo_periods. */
export interface BedSoloSegment {
  bedId: number;
  startDate: ISODate;
  endDate: ISODate | null;
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
  /**
   * A DIFFERENT booking (from `booking`, if any) whose departureDate is this
   * exact date — checkout is exclusive of that date already (the guest's
   * last occupied night is the day before), so this date's own cell is
   * otherwise just "free" or a new arrival's cell, never `booking` itself.
   * Lets the renderer draw a same-day checkout's pill "tail" alongside
   * whatever this cell would already show (a new arrival's pill, or the
   * ordinary "+" new-booking affordance) instead of the outgoing stay
   * simply vanishing a day early.
   */
  departingBooking?: GridBooking;
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
  /**
   * Set only on a native two-person bed (Queen/1.5/Double — `slots.length
   * === 2` on its own, no partner unit). Per-date, aligned with `dates`:
   * true means this date is sold "solo" — the renderer merges the unit's
   * own 2 slots into one row for that column. Undefined for capacity-1
   * units and for joined-pair units (those use `joinBadge` instead).
   */
  soloByDate?: boolean[];
}

export interface RoomGridRow {
  roomId: number;
  roomName: string;
  floorId: number;
  floorName: string;
  /** True only for the system "Dorm Storage" room — see rooms.excludeFromCapacity. */
  excludeFromCapacity: boolean;
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

  // Which slot each booking landed in — needed below to stamp its
  // departingBooking annotation onto the SAME slot's departure-date cell
  // (that date itself is never part of `dateIndexes`, the exclusive-end
  // occupied range, so it's tracked separately from the main pack loop).
  const bookingSlot = new Map<number, number>();

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
    bookingSlot.set(booking.id, slotIndex);
    for (const i of dateIndexes) {
      slots[slotIndex][i] = {
        state: "booked",
        booking,
        isArrival: booking.arrivalDate === dates[i],
        isDeparture: nextDayLocal(dates[i]) === booking.departureDate,
      };
    }
  }

  // Second pass: annotate whichever cell falls exactly on each booking's own
  // departureDate (in its own slot) with a same-day-checkout marker — that
  // date's cell already renders as "free" or a new arrival's "booked" cell
  // from the loop above, and this doesn't change either, only adds a
  // render hint for the pill's half-cell "tail" (see renderBookingPill /
  // renderSingleCell in GridCanvas.tsx).
  for (const booking of ordered) {
    const slotIndex = bookingSlot.get(booking.id);
    if (slotIndex == null) continue;
    const i = dates.findIndex((d) => d === booking.departureDate);
    if (i === -1 || !active[i]) continue;
    slots[slotIndex][i] = { ...slots[slotIndex][i], departingBooking: booking };
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

function unitSortBucket(unit: GridUnit): number {
  if (unit.slots.length === 2) return 2; // native two-person bed (1.5/Queen/Double)
  if (unit.partnerUnitKey != null) return 1; // joined single pair (Couple/Solo Double)
  return 0; // plain unjoined single (or any other capacity-1 unit)
}

/**
 * A joined pair's sort key is the SMALLER of its two bedIds, so a whole pair
 * sorts as one block relative to other beds/pairs in the room, rather than
 * each half sorting independently by its own id (which — since
 * Array.prototype.sort is stable and reorderJoinedPairs already places a
 * pair's two units back-to-back — would otherwise let a room with two or
 * more joined pairs interleave them, e.g. [bed1, bed4] and [bed2, bed5]
 * sorting to [bed1, bed2, bed4, bed5] and splitting each pair apart).
 */
function unitSortKeyBedId(unit: GridUnit, byKey: Map<string, GridUnit>): number {
  if (unit.partnerUnitKey == null) return unit.bedId;
  const partner = byKey.get(unit.partnerUnitKey);
  return partner ? Math.min(unit.bedId, partner.bedId) : unit.bedId;
}

/**
 * Forces a consistent within-room bed order: unjoined singles, then joined
 * single pairs (Couple/Solo Doubles), then native two-person beds (1.5/
 * Queen/Double). Must run AFTER reorderJoinedPairs so partnerUnitKey is
 * already set. Ties break on bedId ascending — NOT original array order,
 * which just reflects whatever order the unordered bed_locations query
 * happened to return and has no relation to "top of the room" — so beds
 * fill top-down (bed 1 before bed 2) deterministically regardless of DB row
 * order. Bed order is fixed by bedId alone (not occupancy), so a bed never
 * moves position as it gets booked/freed — bookings fill the room from the
 * top down instead of occupied beds sinking toward the bottom. Sort is
 * stable and a joined pair's key is its lower bedId (see
 * unitSortKeyBedId), so reorderJoinedPairs' adjacency is preserved even
 * with multiple pairs in one room.
 */
function sortRoomUnits(units: GridUnit[]): GridUnit[] {
  const byKey = new Map(units.map((u) => [u.key, u]));
  return units
    .map((unit) => ({ unit, bucket: unitSortBucket(unit), sortBedId: unitSortKeyBedId(unit, byKey) }))
    .sort((a, b) => a.bucket - b.bucket || a.sortBedId - b.sortBedId)
    .map((entry) => entry.unit);
}

/** Builds the full time-aware grid for the given date window. */
export function buildRoomGrid(
  dates: ISODate[],
  rooms: Array<{ id: number; name: string; floorId: number; floorName: string; excludeFromCapacity: boolean }>,
  bedInfos: GridBedInfo[],
  locationSegments: BedLocationSegment[],
  joinSegments: JoinSegment[],
  soloSegments: BedSoloSegment[],
  bookings: GridBooking[],
  /** type name -> capacity (guests it sleeps) — see loadBedCapacities() in bed-types.ts. */
  capacities: Map<string, number>
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

  // bedId -> solo-active[dateIndex], for native two-person beds. No
  // co-location check needed here (unlike joins) — a solo period only ever
  // concerns the one bed.
  const soloByBed = new Map<number, boolean[]>();
  for (const seg of soloSegments) {
    const arr = soloByBed.get(seg.bedId) ?? new Array(dates.length).fill(false);
    dates.forEach((d, i) => {
      if (coversDate(seg.startDate, seg.endDate, d)) arr[i] = true;
    });
    soloByBed.set(seg.bedId, arr);
  }

  const unitsByRoom = new Map<number, GridUnit[]>();

  for (const [key, active] of activeByBedRoom) {
    if (!active.some(Boolean)) continue;
    const [bedIdStr, roomIdStr] = key.split(":");
    const bedId = Number(bedIdStr);
    const roomId = Number(roomIdStr);
    const type = bedTypeById.get(bedId) ?? "Single";
    const capacity = capacities.get(type) ?? 1;
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

    // A native two-person bed (never appears in joinSegments — joins are
    // Single-only, enforced when a join is created) can independently be
    // sold solo. Blocking the second slot reuses the same capacity/render
    // signal a joined pair's secondary bed uses.
    let soloByDate: boolean[] | undefined;
    if (!joinStatus && capacity === 2) {
      const solo = soloByBed.get(bedId);
      if (solo?.some(Boolean)) {
        soloByDate = solo;
        dates.forEach((_, i) => {
          if (!solo[i]) return;
          const cell = slotCells[1]?.[i];
          if (cell && cell.state === "free") cell.blockedBySoloJoin = true;
        });
      }
    }

    const unit: GridUnit = {
      key,
      bedId,
      label: type,
      slots: slotCells.map((cells) => ({ cells })),
      ...(soloByDate ? { soloByDate } : {}),
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
      excludeFromCapacity: room.excludeFromCapacity,
      units: sortRoomUnits(
        dates.length > 0
          ? reorderJoinedPairs(unitsByRoom.get(room.id) ?? [], joinSegments, windowStart, windowEndExclusive)
          : unitsByRoom.get(room.id) ?? []
      ),
    }));
}

/** Property-wide occupied/total capacity per date, across every room in the grid. */
export function capacityByDate(dates: ISODate[], grid: RoomGridRow[]): CapacityByDate {
  const occupied = dates.map(() => 0);
  const total = dates.map(() => 0);

  for (const room of grid) {
    // A bed parked in Dorm Storage is off active duty — it must yield 0
    // toward house capacity, not just render greyed out.
    if (room.excludeFromCapacity) continue;
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
