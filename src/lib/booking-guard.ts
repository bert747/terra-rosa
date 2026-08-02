import { db } from "@/db";
import { beds, bookings } from "@/db/schema";
import { loadBedCapacities } from "@/lib/bed-types";
import { and, eq, gt, lt, notInArray } from "drizzle-orm";
import type { ISODate } from "@/lib/occupancy";

export interface CapacityCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Guards every write that assigns a bed + date range to a booking (create,
 * move, resize, swap) against exceeding that bed's own capacity — the root
 * cause of grid.ts silently spawning an extra "phantom" occupancy row
 * (packBookingsIntoSlots' overflow branch) instead of the write being
 * rejected outright. A plain Single bed (capacity 1) allows zero
 * overlapping bookings; a native two-person bed (Double/Queen/1.5,
 * capacity 2) allows exactly one other. Every route that writes bedId +
 * arrivalDate/departureDate onto a booking MUST call this first and reject
 * on `!ok` — there is no other place in the schema that enforces it.
 *
 * `excludeBookingIds` is a list (not a single id) because a SWAP checks
 * each booking's new placement against the OTHER booking it's trading
 * places with too — that other booking is mid-move in the very same
 * operation, not a genuine capacity conflict, even though it's still
 * sitting in its old spot at the instant this runs (see POST
 * /api/bookings/swap, the only caller that passes more than one id).
 */
export async function checkBedCapacity(
  bedId: number | null,
  arrivalDate: ISODate,
  departureDate: ISODate,
  excludeBookingIds: number[] = []
): Promise<CapacityCheckResult> {
  if (bedId == null) return { ok: true }; // unassigned bookings don't occupy any bed

  const [bed] = await db.select().from(beds).where(eq(beds.id, bedId));
  if (!bed) return { ok: true }; // nonexistent bed — the caller's own FK/lookup handles that error

  const capacities = await loadBedCapacities();
  const capacity = capacities.get(bed.type) ?? 1;

  const conditions = [eq(bookings.bedId, bedId), lt(bookings.arrivalDate, departureDate), gt(bookings.departureDate, arrivalDate)];
  if (excludeBookingIds.length > 0) conditions.push(notInArray(bookings.id, excludeBookingIds));

  const overlapping = await db
    .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(...conditions));

  if (overlapping.length >= capacity) {
    const names = overlapping.map((b) => `${b.guestName} (${b.arrivalDate} to ${b.departureDate})`).join(", ");
    return {
      ok: false,
      error: `This bed is already fully booked for that date range by ${names} — this would create overlapping occupancy on one bed instead of a real placement. Split or move the existing booking(s) first, or choose a different bed/date range.`,
    };
  }
  return { ok: true };
}
