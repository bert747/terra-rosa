import { db } from "@/db";
import { bookings } from "@/db/schema";
import { and, gt, isNull, lt, notInArray } from "drizzle-orm";
import { loadGridData } from "@/lib/grid-data";
import { nightsBetween } from "@/lib/dates";
import type { ISODate } from "@/lib/occupancy";
import type { CapacityCheckResult } from "@/lib/booking-guard";

/**
 * Guards a booking that will end up UNASSIGNED (bedId null) against the
 * house genuinely having no room left, on any night of its stay. A specific
 * bed assignment is already bounded by checkBedCapacity (src/lib/
 * booking-guard.ts) — that's a stricter, per-bed check and therefore always
 * within total house capacity, so this only needs to run for the
 * unassigned case. Every route that can leave a booking's bedId null MUST
 * call this first and reject on `!ok`, mirroring checkBedCapacity's
 * contract — otherwise an unassigned booking can be created for a date
 * range the house has zero spare capacity on, which just defers the
 * "doesn't fit anywhere" problem to whoever tries to manually place it
 * later instead of catching it at booking time.
 */
export async function checkHouseCapacity(
  arrivalDate: ISODate,
  departureDate: ISODate,
  excludeBookingIds: number[] = []
): Promise<CapacityCheckResult> {
  const nights = nightsBetween(arrivalDate, departureDate);
  if (nights <= 0) return { ok: true }; // invalid range — the caller's own date validation handles that error

  const { dates, occupiedByDate, totalByDate } = await loadGridData(arrivalDate, nights);

  // occupiedByDate only counts bed-ASSIGNED bookings (it's derived from the
  // grid, which is built per-bed) — an unassigned booking doesn't occupy a
  // bed cell, but it still represents a guest who needs a spot, so it must
  // be tallied here too or the house could be "full" on paper while still
  // accepting unlimited unassigned bookings for the same dates.
  const unassignedRows = await db
    .select({ arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(
      and(
        isNull(bookings.bedId),
        lt(bookings.arrivalDate, departureDate),
        gt(bookings.departureDate, arrivalDate),
        ...(excludeBookingIds.length > 0 ? [notInArray(bookings.id, excludeBookingIds)] : [])
      )
    );

  const unassignedCountByDate = dates.map(
    (d) => unassignedRows.filter((b) => b.arrivalDate <= d && b.departureDate > d).length
  );

  for (let i = 0; i < dates.length; i++) {
    const takenIncludingThisOne = occupiedByDate[i] + unassignedCountByDate[i] + 1;
    if (takenIncludingThisOne > totalByDate[i]) {
      return {
        ok: false,
        error: `The house is full on ${dates[i]} (${totalByDate[i]} of ${totalByDate[i]} spots already taken).`,
      };
    }
  }

  return { ok: true };
}
