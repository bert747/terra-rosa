import { and, eq, gt, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, rooms, roomCapacityOverrides, stayRoomSegments } from "@/db/schema";
import {
  guardianOccupiesOnDate,
  guardianOverridesInRange,
} from "@/lib/guardian-presence";

// ---------------------------------------------------------------------------
// Terra Rosa occupancy & meal-count math.
//
// This is the single source of truth for these calculations — every page
// (grid, dashboard, meals) should call into these functions rather than
// re-deriving numbers inline, so the rule below stays correct everywhere.
//
// Definitions (from the architecture proposal, must not drift):
//
//   Occupancy of a room on the night of date D
//     = SUM(guest_count) from stay_room_segments
//       where start_date <= D AND end_date > D
//       and the parent booking has status = 'confirmed'.
//
//   Property-wide O(D) = sum of per-room occupancy across rooms where
//       rooms.is_active = true (inactive rooms excluded) — capacity-counting
//       is further filtered by bookings.counts_toward_capacity = true.
//
//   Arrivals(D)   = bookings with check_in_date = D (confirmed only)
//   Departures(D) = bookings with check_out_date = D (confirmed only)
//
//   Capacity(room, D) = bed_count from room_capacity_overrides covering D,
//       else rooms.default_bed_count.
//
//   Capacity conflict on (room, D) = occupancy(room, D) > capacity(room, D)
//
//   Breakfast(D) = O(D-1)
//   Lunch(D)     = O(D-1) - Departures(D)
//   Dinner(D)    = O(D-1) - Departures(D) + Arrivals(D)  [ = O(D) ]
//
// Worked example from the spec: today's occupancy O(D-1) = 10, tomorrow has
// 4 departures and 2 arrivals -> tomorrow's breakfast = 10, lunch = 6,
// dinner = 8. Covered by the test in scripts/check-occupancy.ts.
// ---------------------------------------------------------------------------

export type ISODate = string; // "YYYY-MM-DD"

function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Returns the ISO date string for the day before the given ISO date. */
export function previousDay(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return toISODate(d);
}

/** Returns the ISO date string for the day after the given ISO date. */
export function nextDay(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return toISODate(d);
}

/**
 * Per-room occupancy (guest count) for the night of `date`, for every active
 * room. Rooms with zero occupancy are included with count 0.
 *
 * Only counts confirmed bookings. Does NOT filter by counts_toward_capacity —
 * callers that need the capacity-eligible total should filter/join against
 * bookings.counts_toward_capacity themselves (see occupancyByRoomForCapacity).
 */
export async function occupancyByRoom(date: ISODate): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const segments = await segmentsInRange(date, nextDay(date));
  for (const segment of segments) {
    map.set(segment.roomId, (map.get(segment.roomId) ?? 0) + segment.guestCount);
  }
  return map;
}

/**
 * Same as occupancyByRoom, but only counts segments whose parent booking has
 * counts_toward_capacity = true. Use this for capacity-conflict checks and
 * for the property-wide O(D) figure used in meal calculations.
 */
export async function occupancyByRoomForCapacity(date: ISODate): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const segments = await segmentsInRange(date, nextDay(date));
  for (const segment of segments) {
    if (!segment.countsTowardCapacity) continue;
    map.set(segment.roomId, (map.get(segment.roomId) ?? 0) + segment.guestCount);
  }
  return map;
}

/** Property-wide occupancy O(D): sum across active rooms, capacity-eligible bookings only. */
export async function propertyOccupancy(date: ISODate): Promise<number> {
  const byRoom = await occupancyByRoomForCapacity(date);
  const activeRoomIds = new Set(
    (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.isActive, true))).map(
      (r) => r.id
    )
  );
  let total = 0;
  for (const [roomId, count] of byRoom) {
    if (activeRoomIds.has(roomId)) total += count;
  }
  return total;
}

/** Count of bookings (confirmed) checking in on `date`. Each booking contributes its guest_count. */
export async function arrivals(date: ISODate): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${bookings.guestCount}), 0)` })
    .from(bookings)
    .where(and(eq(bookings.status, "confirmed"), eq(bookings.checkInDate, date)));
  return Number(rows[0]?.total ?? 0);
}

/** Count of bookings (confirmed) checking out on `date`. Each booking contributes its guest_count. */
export async function departures(date: ISODate): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`COALESCE(SUM(${bookings.guestCount}), 0)` })
    .from(bookings)
    .where(and(eq(bookings.status, "confirmed"), eq(bookings.checkOutDate, date)));
  return Number(rows[0]?.total ?? 0);
}

/** Effective bed capacity for a room on `date`: override if one covers the date, else default. */
export async function roomCapacity(roomId: number, date: ISODate): Promise<number> {
  const overrides = await db
    .select()
    .from(roomCapacityOverrides)
    .where(
      and(
        eq(roomCapacityOverrides.roomId, roomId),
        lte(roomCapacityOverrides.startDate, date),
        gt(roomCapacityOverrides.endDate, date)
      )
    )
    .limit(1);

  if (overrides.length > 0) return overrides[0].bedCount;

  const room = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return room[0]?.defaultBedCount ?? 0;
}

/**
 * Effective bed capacity for every active room across a list of dates, in one
 * pass. Same rule as roomCapacity (override wins, else default) — use this
 * instead of calling roomCapacity in a loop, which issues two queries per
 * room per date.
 *
 * Returns roomId -> capacity per date, index-aligned with `dates`.
 */
export async function roomCapacitiesForDates(
  dates: ISODate[]
): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>();
  if (dates.length === 0) return result;

  const windowStart = dates[0];
  const windowEnd = nextDay(dates[dates.length - 1]); // exclusive

  const [activeRooms, overrides] = await Promise.all([
    db.select().from(rooms).where(eq(rooms.isActive, true)),
    db
      .select()
      .from(roomCapacityOverrides)
      .where(
        and(
          lt(roomCapacityOverrides.startDate, windowEnd),
          gt(roomCapacityOverrides.endDate, windowStart)
        )
      ),
  ]);

  for (const room of activeRooms) {
    result.set(
      room.id,
      dates.map(() => room.defaultBedCount)
    );
  }

  for (const override of overrides) {
    const perDate = result.get(override.roomId);
    if (!perDate) continue; // inactive room
    dates.forEach((d, i) => {
      if (override.startDate <= d && override.endDate > d) {
        perDate[i] = override.bedCount;
      }
    });
  }

  return result;
}

/** A stay segment overlapping a date window, joined to its booking's details. */
export interface SegmentWithGuest {
  id: number;
  bookingId: number;
  roomId: number;
  preferredBed: number | null;
  startDate: ISODate;
  /** Exclusive: the guest's last night is the day before this date. */
  endDate: ISODate;
  guestCount: number;
  leadGuestName: string;
  notes: string | null;
  bookingType: "guest" | "resident" | "guardian" | "worker";
  countsTowardCapacity: boolean;
}

/**
 * Every confirmed stay segment overlapping the half-open window
 * [start, end) — i.e. occupying at least one night in it — with the lead
 * guest name attached. Used by the bed grid to label cells.
 */
export async function segmentsInRange(
  start: ISODate,
  end: ISODate
): Promise<SegmentWithGuest[]> {
  const rows = await db
    .select({
      id: stayRoomSegments.id,
      bookingId: stayRoomSegments.bookingId,
      roomId: stayRoomSegments.roomId,
      preferredBed: stayRoomSegments.preferredBed,
      startDate: stayRoomSegments.startDate,
      endDate: stayRoomSegments.endDate,
      guestCount: stayRoomSegments.guestCount,
      leadGuestName: bookings.leadGuestName,
      notes: bookings.notes,
      bookingType: bookings.bookingType,
      countsTowardCapacity: bookings.countsTowardCapacity,
    })
    .from(stayRoomSegments)
    .innerJoin(bookings, eq(stayRoomSegments.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        lt(stayRoomSegments.startDate, end),
        gt(stayRoomSegments.endDate, start)
      )
    );

  const guardianBookingIds = Array.from(
    new Set(rows.filter((row) => row.bookingType === "guardian").map((row) => row.bookingId))
  );

  if (guardianBookingIds.length === 0) return rows;

  const overridesByBooking = await guardianOverridesInRange(guardianBookingIds, start, end);
  const adjusted: SegmentWithGuest[] = [];

  for (const row of rows) {
    if (row.bookingType !== "guardian") {
      adjusted.push(row);
      continue;
    }

    const segmentStart = row.startDate > start ? row.startDate : start;
    const segmentEnd = row.endDate < end ? row.endDate : end;
    if (segmentStart >= segmentEnd) continue;

    const bookingOverrides = overridesByBooking.get(row.bookingId) ?? [];
    let cursor = segmentStart;

    while (cursor < segmentEnd) {
      const occupied = guardianOccupiesOnDate(cursor, bookingOverrides);
      const runStart = cursor;
      let next = nextDay(cursor);

      while (next < segmentEnd && guardianOccupiesOnDate(next, bookingOverrides) === occupied) {
        cursor = next;
        next = nextDay(cursor);
      }

      const runEnd = next;
      if (occupied) {
        adjusted.push({
          ...row,
          startDate: runStart,
          endDate: runEnd,
        });
      }
      cursor = next;
    }
  }

  return adjusted;
}

export interface MealCounts {
  date: ISODate;
  breakfast: number;
  lunch: number;
  dinner: number;
}

/**
 * Meal counts for `date`, using the previous night's property occupancy plus
 * that day's arrivals/departures. See module doc comment for the formulas.
 */
export async function mealCountsForDate(date: ISODate): Promise<MealCounts> {
  const prevOccupancy = await propertyOccupancy(previousDay(date));
  const dep = await departures(date);
  const arr = await arrivals(date);

  const breakfast = prevOccupancy;
  const lunch = prevOccupancy - dep;
  const dinner = prevOccupancy - dep + arr;

  return { date, breakfast, lunch, dinner };
}

export interface RoomDayStatus {
  roomId: number;
  occupancy: number;
  capacity: number;
  isOverCapacity: boolean;
}

/** Per-room occupancy + capacity + conflict flag for every active room on `date`. */
export async function roomStatusesForDate(date: ISODate): Promise<RoomDayStatus[]> {
  const [activeRooms, byRoom] = await Promise.all([
    db.select().from(rooms).where(eq(rooms.isActive, true)),
    occupancyByRoomForCapacity(date),
  ]);

  const results: RoomDayStatus[] = [];
  for (const room of activeRooms) {
    const occupancy = byRoom.get(room.id) ?? 0;
    const capacity = await roomCapacity(room.id, date);
    results.push({
      roomId: room.id,
      occupancy,
      capacity,
      isOverCapacity: occupancy > capacity,
    });
  }
  return results;
}
