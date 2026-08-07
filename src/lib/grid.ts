import type { ISODate } from "@/lib/occupancy";

// ---------------------------------------------------------------------------
// Time-aware grid layout.
//
// The grid is built fresh for whatever [dates[0], dates[last]] window is
// being viewed: bed placements and joins are resolved as of THOSE dates, not
// "current" state. A bed whose bed_locations row only starts in September
// contributes nothing when viewing July — no ghost rows.
//
// Row model: one row per (bed, room) placement segment that's still active
// today or starts later — a segment that ended before today gets no row at
// all, even scrolled back into view, since a room a bed already moved out of
// is dead history, not a live spot to check. A bed moving rooms partway
// through the FUTURE portion of the window still gets a row in each room,
// active only for its own sub-range — cells outside a row's active range
// render as "inactive" rather than bookable, which is how a row visually
// "sprouts" partway across the date columns without breaking the table's
// fixed row/column structure.
//
// Row-coalescing: what matters to a viewer isn't which physical bed sits in
// a spot, it's how many spots the room has each night. So when bed A's stay
// in a room ends exactly where bed B (same type) starts — zero date gap,
// same room — the two segments merge into ONE row rather than showing a
// phantom "departure" and "arrival" for a spot that, from the room's
// perspective, never actually changed. Occupancy right at the seam doesn't
// block the merge — a guest checking into the new bed the same day the old
// one left is the ordinary case, not an edge case — see the chain-building
// pass in buildRoomGrid.
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
  firstName: string;
  /** Short/preferred form of firstName — see the schema column's own doc comment. Pill display prefers this, falling back to firstName. */
  preferredName?: string | null;
  /** Free-text staff note — see the schema column's own doc comment. Surfaced as a small folded-corner marker on the pill, not shown inline. */
  notes?: string | null;
  arrivalDate: ISODate;
  /** Exclusive: the guest's last night is the day before this date. */
  departureDate: ISODate;
  bedId: number;
  /** Its own "Sleeps near"/"Shares bed with" isn't currently met — see findAllocationIssues. */
  allocationIssues?: { otherGuestName: string; kind: "room" | "bed" }[];
  /** Shared by every piece of the same split-into-parts stay — see the bookings.splitGroupId schema comment. Null for a plain, never-split booking. */
  splitGroupId?: number | null;
  /**
   * This booking's own declared "Sleeps near" (room) or "Shares bed with"
   * (bed) partner, with their CURRENT guest name — set whenever the
   * relationship exists, whether or not it's currently being met (that's
   * a separate, narrower signal — see allocationIssues above, which only
   * fires when it's NOT met). Powers the pill's "(same bed as X)" label.
   */
  relationship?: { kind: "room" | "bed"; otherGuestName: string };
  /** This booking's guest category's colour (hex), or null if uncategorised or that category was deleted with no colour to fall back on. Drives the pill's background/border — see guestCategories in schema.ts. */
  guestCategoryColour?: string | null;
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
  /**
   * Set only when this row is a merged chain (see buildRoomGrid's
   * row-coalescing pass) — the actual physical bed active at each date
   * index, or null where the row is inactive. `bedId` above still names ONE
   * representative bed (whichever is active today, or the soonest upcoming
   * one) for actions that need a single id, like the row label's context
   * menu; per-date actions (the "+" new-booking cell, drag-and-drop targets)
   * must consult this instead so they target the bed actually in service on
   * that exact date.
   */
  bedIdByDate?: (number | null)[];
  /**
   * The latest departure date among this unit's own current/future bookings
   * (within the loaded window — see sortRoomUnits), or null if it has none.
   * Drives row order: a bed booked further out is less "movable" — staff
   * won't want to reconfigure it — so it sorts higher, while a bed with
   * nothing on the books at all sorts to the bottom regardless of how far
   * the free stretch runs. Bounded by whatever window buildRoomGrid was
   * called with, same as everything else here — a booking past the loaded
   * horizon isn't visible to this calculation, which in practice only
   * matters for a booking further out than the ~60-day rolling window ever
   * loads.
   */
  latestBookedDate?: ISODate | null;
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

function parseBedRoomKey(key: string): { bedId: number; roomId: number } {
  const [bedIdStr, roomIdStr] = key.split(":");
  return { bedId: Number(bedIdStr), roomId: Number(roomIdStr) };
}

function coversDate(startDate: ISODate, endDate: ISODate | null, date: ISODate): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

/**
 * Packs a bed's bookings onto `slotCount` parallel slots, one booking per
 * slot per active night.
 *
 * `bedIdAt`, when given (a row-coalesced merged unit — see buildRoomGrid),
 * is the actual physical bed active at each date index. `bookings` is
 * whichever bed a booking's own row happens to be for, keyed by bedId
 * ACROSS THAT BED'S WHOLE HISTORY — a bed that passed through three
 * different rooms over its lifetime still has just one bookingsByBed
 * entry, all of its bookings together, regardless of which room it was in
 * when each one happened. Without `bedIdAt`, a single (bed, room) key's own
 * `active` window already scopes this correctly (a booking's dates can only
 * land on indices where that exact bed was actually in that exact room).
 * But a MERGED chain's `active` is the union of several different beds'
 * windows, and `bookings` is the union of their bookings too — so a booking
 * that truly belongs to an EARLIER bed in the chain, in a date range that
 * happens to fall inside a LATER bed's own window, would otherwise get
 * placed there by date-overlap alone, showing that guest's pill split
 * across a room the booking was never actually in. `bedIdAt` closes that
 * gap: a date index only counts toward a booking if that booking's own
 * bedId is the one actually active there.
 */
function packBookingsIntoSlots(
  dates: ISODate[],
  active: boolean[],
  bookings: GridBooking[],
  slotCount: number,
  bedIdAt?: (number | null)[]
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
      if (!active[i]) return;
      if (bedIdAt && bedIdAt[i] !== booking.bedId) return;
      if (booking.arrivalDate <= d && booking.departureDate > d) dateIndexes.push(i);
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
    // Deliberately NOT gated on bedIdAt like the main pack loop above — a
    // same-day checkout landing exactly on a row-coalesced chain's handoff
    // date is the expected case (the outgoing bed's last morning IS the
    // incoming bed's first day), and the tail is exactly what should show
    // there, bridging the two physical beds on this one merged row.
    slots[slotIndex][i] = { ...slots[slotIndex][i], departingBooking: booking };
  }

  return slots;
}

function windowOverlaps(seg: { startDate: ISODate; endDate: ISODate | null }, windowStart: ISODate, windowEndExclusive: ISODate): boolean {
  // A segment whose endDate isn't strictly after its own startDate never
  // covers any real date — a stale/corrupt row, not a genuine (even
  // zero-width-in-window) overlap. Without this, such a row can still
  // satisfy both halves of the check below (its endDate can sit anywhere
  // after windowStart even though it's before its OWN startDate) and gets
  // treated as a real pairing purely by coincidence of unrelated dates —
  // this is what produced a phantom join between two beds that were never
  // actually joined for any visible date.
  if (seg.endDate != null && seg.endDate <= seg.startDate) return false;
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
 * A joined pair sorts as one block by whichever half is booked FURTHER out
 * — the pair as a whole is only as "movable" as its most-committed half.
 */
function unitSortKeyLatestBooked(unit: GridUnit, byKey: Map<string, GridUnit>): ISODate | null {
  if (unit.partnerUnitKey == null) return unit.latestBookedDate ?? null;
  const partner = byKey.get(unit.partnerUnitKey);
  const own = unit.latestBookedDate ?? null;
  const other = partner?.latestBookedDate ?? null;
  if (own == null) return other;
  if (other == null) return own;
  return own > other ? own : other;
}

/**
 * Room-wide bed order, across every unit type at once (unjoined singles,
 * joined single pairs, native two-person beds all mixed together). Must run
 * AFTER reorderJoinedPairs so partnerUnitKey is already set.
 *
 * Primary key: how far out a unit is already committed — the latest
 * departure date among its own current/future bookings, furthest first, NOT
 * by bed type. The bed staff can least afford to touch (booked solid the
 * furthest into the future) sits at the top, whether that's a plain Single,
 * a Couple Double, or a native Queen — a half-full Couple Double is more
 * "spoken for" than a completely empty Single next to it, and must outrank
 * it. (Bed type used to be checked FIRST here, which put every empty Single
 * above every occupied Double/pair regardless of actual occupancy — the
 * exact wrong-order bug this replaces.) A unit with nothing booked at all
 * sits at the very bottom, below even one that's free today but has
 * something booked next month. This ordering is deliberately stable as the
 * viewed window scrolls forward in time: a unit's rank only ever changes
 * when its OWN booking data changes, never just because "today" moved — so
 * as units actually empty out over time, they do so in the order they're
 * already sitting in, top to bottom, and a row never jumps position purely
 * from scrolling.
 *
 * Ties (including several units with no booking at all) fall back to bed
 * TYPE (unjoined singles, then joined pairs, then native two-person beds)
 * and finally bedId ascending, so a room of otherwise-equally-free beds
 * still fills top-down deterministically instead of in arbitrary order. A
 * joined pair's keys are its lower bedId and its most-committed half (see
 * unitSortKeyBedId / unitSortKeyLatestBooked), so reorderJoinedPairs'
 * adjacency is preserved even with multiple pairs in one room.
 */
function sortRoomUnits(units: GridUnit[]): GridUnit[] {
  const byKey = new Map(units.map((u) => [u.key, u]));
  return units
    .map((unit) => ({
      unit,
      bucket: unitSortBucket(unit),
      sortBedId: unitSortKeyBedId(unit, byKey),
      latestBooked: unitSortKeyLatestBooked(unit, byKey),
    }))
    .sort((a, b) => {
      if (a.latestBooked == null && b.latestBooked != null) return 1;
      if (a.latestBooked != null && b.latestBooked == null) return -1;
      if (a.latestBooked != null && b.latestBooked != null && a.latestBooked !== b.latestBooked) {
        return a.latestBooked < b.latestBooked ? 1 : -1;
      }
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      return a.sortBedId - b.sortBedId;
    })
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
  capacities: Map<string, number>,
  /** Real calendar today — a (bed, room) segment that ended before this gets no row at all, even scrolled back into view (see the loop below). */
  today: ISODate
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

  // Real start/end for every (bed, room) key, straight from the raw
  // segments — needed for handoff adjacency below, independent of whether
  // the segment actually falls inside the viewed date window.
  const keyRange = new Map<string, { start: ISODate; end: ISODate | null }>();
  for (const seg of locationSegments) {
    const key = `${seg.bedId}:${seg.roomId}`;
    const existing = keyRange.get(key);
    if (!existing) {
      keyRange.set(key, { start: seg.startDate, end: seg.endDate });
    } else {
      if (seg.startDate < existing.start) existing.start = seg.startDate;
      existing.end = existing.end == null || seg.endDate == null ? null : (seg.endDate > existing.end ? seg.endDate : existing.end);
    }
  }

  // Only keys with at least one visible-window cell can anchor or extend a
  // rendered row — a key with zero overlap with `dates` contributes no
  // cells either way, merged or not, so it's simply left out of chaining.
  const inWindowKeys = new Set(
    [...activeByBedRoom.entries()].filter(([, active]) => active.some(Boolean)).map(([key]) => key)
  );

  // What a room "has" of a given bed type, night to night, is a CAPACITY —
  // not a fixed set of physical beds. So rather than only ever chaining one
  // key to the very next one that happens to pick up exactly where it left
  // off, every key in a (room, type) group competes for a small number of
  // shared "slots" — classic interval scheduling (the same shape as "how
  // few meeting rooms do these bookings need"). Each key gets assigned to
  // whichever slot is free (its previous occupant's window already ended by
  // this key's start) and, among those, whichever leaves the smallest gap —
  // a zero-gap handoff always wins, so a clean swap still reads as one
  // continuous row, but a genuine gap (the room briefly had ONE FEWER bed of
  // that type) now also reuses a row instead of permanently allocating a new
  // one. This directly generalizes the old 1:1-successor version: it also
  // now handles three or more beds rotating through the same slot, and never
  // declines to merge just because more than one candidate could follow.
  const keysByRoomType = new Map<string, string[]>();
  for (const key of inWindowKeys) {
    const { roomId, bedId } = parseBedRoomKey(key);
    const type = bedTypeById.get(bedId) ?? "Single";
    const groupKey = `${roomId}|${type}`;
    const list = keysByRoomType.get(groupKey);
    if (list) list.push(key);
    else keysByRoomType.set(groupKey, [key]);
  }

  const slotByKey = new Map<string, number>();
  for (const keys of keysByRoomType.values()) {
    const sorted = [...keys].sort((a, b) => keyRange.get(a)!.start.localeCompare(keyRange.get(b)!.start));
    const slotEnds: (ISODate | null)[] = [];
    for (const key of sorted) {
      const range = keyRange.get(key)!;
      let slotIndex = -1;
      let bestEnd: ISODate | null = null;
      for (let i = 0; i < slotEnds.length; i++) {
        const end = slotEnds[i];
        if (end != null && end <= range.start && (bestEnd == null || end > bestEnd)) {
          bestEnd = end;
          slotIndex = i;
        }
      }
      if (slotIndex === -1) {
        slotIndex = slotEnds.length;
        slotEnds.push(range.end);
      } else {
        slotEnds[slotIndex] = range.end;
      }
      slotByKey.set(key, slotIndex);
    }
  }

  const chainGroups = new Map<string, string[]>();
  for (const key of inWindowKeys) {
    const { roomId, bedId } = parseBedRoomKey(key);
    const type = bedTypeById.get(bedId) ?? "Single";
    const groupKey = `${roomId}|${type}|${slotByKey.get(key)}`;
    const list = chainGroups.get(groupKey);
    if (list) list.push(key);
    else chainGroups.set(groupKey, [key]);
  }
  const chains: string[][] = [...chainGroups.values()];

  for (const chainKeys of chains) {
    const { roomId } = parseBedRoomKey(chainKeys[0]);
    const type = bedTypeById.get(parseBedRoomKey(chainKeys[0]).bedId) ?? "Single";
    const capacity = capacities.get(type) ?? 1;

    const combinedActive = dates.map((_, i) => chainKeys.some((k) => activeByBedRoom.get(k)![i]));
    // A chain that's ENTIRELY in the past (every member already moved on)
    // gets no row at all — a room a bed used to be in is dead history, not
    // something worth a permanently greyed-out row. Active today, or
    // starting later (a preview of an upcoming move), still sprouts in.
    if (!combinedActive.some((a, i) => a && dates[i] >= today)) continue;

    const bedIdAt: (number | null)[] = dates.map((_, i) => {
      const activeKey = chainKeys.find((k) => activeByBedRoom.get(k)![i]);
      return activeKey ? parseBedRoomKey(activeKey).bedId : null;
    });

    const combinedBookings = chainKeys.flatMap((k) => bookingsByBed.get(parseBedRoomKey(k).bedId) ?? []);
    const slotCells = packBookingsIntoSlots(dates, combinedActive, combinedBookings, capacity, bedIdAt);

    const joinBadgeAt: (JoinBadge | null)[] = dates.map((_, i) => {
      const activeBedId = bedIdAt[i];
      return activeBedId != null ? (joinStatusByBed.get(activeBedId)?.[i] ?? null) : null;
    });
    const hasJoin = joinBadgeAt.some(Boolean);
    if (hasJoin) {
      // Only the single-capacity slot (index 0) can be a joined bed.
      dates.forEach((_, i) => {
        const badge = joinBadgeAt[i];
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
    if (!hasJoin && capacity === 2) {
      const combinedSolo = dates.map((_, i) => {
        const activeBedId = bedIdAt[i];
        return activeBedId != null ? (soloByBed.get(activeBedId)?.[i] ?? false) : false;
      });
      if (combinedSolo.some(Boolean)) {
        soloByDate = combinedSolo;
        dates.forEach((_, i) => {
          if (!combinedSolo[i]) return;
          const cell = slotCells[1]?.[i];
          if (cell && cell.state === "free") cell.blockedBySoloJoin = true;
        });
      }
    }

    // The one bedId actions that need a single id (the row label's own
    // context menu) should target: whichever bed is active today, else the
    // soonest upcoming one — both are guaranteed to exist by the
    // "combinedActive today-or-later" check above.
    let representativeBedId =
      bedIdAt[dates.findIndex((d) => d === today)] ??
      bedIdAt.find((id, i) => id != null && dates[i] >= today) ??
      null;
    if (representativeBedId == null) representativeBedId = parseBedRoomKey(chainKeys[chainKeys.length - 1]).bedId;

    let latestBookedDate: ISODate | null = null;
    for (const b of combinedBookings) {
      if (b.departureDate <= today) continue; // already checked out — doesn't commit this bed to anything
      if (latestBookedDate == null || b.departureDate > latestBookedDate) latestBookedDate = b.departureDate;
    }

    const unit: GridUnit = {
      key: chainKeys.join("|"),
      bedId: representativeBedId,
      label: type,
      slots: slotCells.map((cells) => ({ cells })),
      latestBookedDate,
      ...(soloByDate ? { soloByDate } : {}),
      ...(chainKeys.length > 1 ? { bedIdByDate: bedIdAt } : {}),
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
