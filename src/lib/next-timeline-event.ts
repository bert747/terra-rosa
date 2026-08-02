import { db } from "@/db";
import { bedLocations, bedSoloPeriods, bookings, joinedBeds } from "@/db/schema";
import { inArray, or } from "drizzle-orm";
import type { ISODate } from "@/lib/occupancy";

/**
 * The earliest date after `afterDate` where something already scheduled
 * changes for any of `bedIds` — a booking arriving/departing, a bed moving
 * room, a join/solo-period starting/ending. Used to give an auto-created
 * join (see "Auto-Join Fallback" and "Shares Bed With") a sensible default
 * end date instead of leaving it open-ended forever when the timeline
 * already has something else planned for one of these beds. Returns null
 * (open-ended) if nothing is scheduled.
 */
export async function nextTimelineEventDate(bedIds: number[], afterDate: ISODate): Promise<ISODate | null> {
  if (bedIds.length === 0) return null;

  const [bookingRows, locationRows, joinRows, soloRows] = await Promise.all([
    db
      .select({ arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
      .from(bookings)
      .where(inArray(bookings.bedId, bedIds)),
    db
      .select({ startDate: bedLocations.startDate, endDate: bedLocations.endDate })
      .from(bedLocations)
      .where(inArray(bedLocations.bedId, bedIds)),
    db
      .select({ startDate: joinedBeds.startDate, endDate: joinedBeds.endDate })
      .from(joinedBeds)
      .where(or(inArray(joinedBeds.bed1Id, bedIds), inArray(joinedBeds.bed2Id, bedIds))),
    db
      .select({ startDate: bedSoloPeriods.startDate, endDate: bedSoloPeriods.endDate })
      .from(bedSoloPeriods)
      .where(inArray(bedSoloPeriods.bedId, bedIds)),
  ]);

  const candidates: ISODate[] = [];
  for (const b of bookingRows) {
    candidates.push(b.arrivalDate, b.departureDate);
  }
  for (const rows of [locationRows, joinRows, soloRows]) {
    for (const r of rows) {
      candidates.push(r.startDate);
      if (r.endDate) candidates.push(r.endDate);
    }
  }

  const future = candidates.filter((d) => d > afterDate).sort();
  return future[0] ?? null;
}
