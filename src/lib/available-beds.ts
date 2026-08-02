import { db } from "@/db";
import { beds, bedLocations, bookings, floors, rooms } from "@/db/schema";
import { and, eq, gt, lt, notInArray } from "drizzle-orm";
import { loadBedCapacities } from "@/lib/bed-types";
import type { ISODate } from "@/lib/occupancy";

export interface AvailableBed {
  id: number;
  type: string;
  roomId: number;
  roomName: string;
  floorId: number;
  floorName: string;
}

/**
 * Beds genuinely offerable for a date range: placed in a real room (not an
 * "unplaced" bed with no bed_locations row — that's layout setup in
 * progress, not bookable) AND with spare capacity for the range. Shared by
 * GET /api/beds/available (which layers Bed Type filtering + Auto-Join
 * Fallback pairing on top, see that route) and POST /api/bookings/
 * auto-allocate (which just needs a plain fit, no form-specific filtering).
 */
export async function findAvailableBeds({
  arrivalDate,
  departureDate,
  excludeBookingId,
  nearRoomId,
}: {
  arrivalDate: ISODate;
  departureDate: ISODate;
  excludeBookingId?: number | null;
  nearRoomId?: number | null;
}): Promise<AvailableBed[]> {
  const [allBeds, placements, overlapping, capacities] = await Promise.all([
    db.select().from(beds),
    db
      .select({
        bedId: bedLocations.bedId,
        roomId: rooms.id,
        roomName: rooms.name,
        floorId: floors.id,
        floorName: floors.name,
        startDate: bedLocations.startDate,
        endDate: bedLocations.endDate,
      })
      .from(bedLocations)
      .innerJoin(rooms, eq(bedLocations.roomId, rooms.id))
      .innerJoin(floors, eq(rooms.floorId, floors.id)),
    db
      .select({ bedId: bookings.bedId })
      .from(bookings)
      .where(
        and(
          lt(bookings.arrivalDate, departureDate),
          gt(bookings.departureDate, arrivalDate),
          ...(excludeBookingId ? [notInArray(bookings.id, [excludeBookingId])] : [])
        )
      ),
    loadBedCapacities(),
  ]);

  // A bed is "placed" for this range if it has a location segment active on
  // the ARRIVAL date — same rule the bookings list uses to show a stay's
  // room (see roomNameForBooking in app/bookings/page.tsx).
  const placementByBed = new Map<number, (typeof placements)[number]>();
  for (const p of placements) {
    if (p.startDate <= arrivalDate && (p.endDate == null || p.endDate > arrivalDate)) {
      placementByBed.set(p.bedId, p);
    }
  }

  const bookedCountByBed = new Map<number, number>();
  for (const b of overlapping) {
    if (b.bedId == null) continue;
    bookedCountByBed.set(b.bedId, (bookedCountByBed.get(b.bedId) ?? 0) + 1);
  }

  return allBeds
    .map((bed) => {
      const placement = placementByBed.get(bed.id);
      if (!placement) return null;
      if (nearRoomId != null && placement.roomId !== nearRoomId) return null;
      const bookedCount = bookedCountByBed.get(bed.id) ?? 0;
      if (bookedCount >= (capacities.get(bed.type) ?? 1)) return null;
      return {
        id: bed.id,
        type: bed.type,
        roomId: placement.roomId,
        roomName: placement.roomName,
        floorId: placement.floorId,
        floorName: placement.floorName,
      };
    })
    .filter((row): row is AvailableBed => row != null);
}
