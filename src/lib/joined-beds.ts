import { db } from "@/db";
import { bookings, joinedBeds } from "@/db/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

/** Does this [startDate, endDate) segment cover `date`? Half-open, endDate null = open-ended. */
export function coversDate(startDate: string, endDate: string | null, date: string): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

/**
 * The join segment (either orientation) for this bed pair that covers
 * `atDate`, if any — shared by the "Split into Singles" and "Switch to
 * Couple/Solo Double" grid actions, which both start from just the two bed
 * ids and the clicked date, not a join row id.
 */
export async function findActiveJoin(bed1Id: number, bed2Id: number, atDate: string) {
  const candidates = await db
    .select()
    .from(joinedBeds)
    .where(
      and(
        or(
          and(eq(joinedBeds.bed1Id, bed1Id), eq(joinedBeds.bed2Id, bed2Id)),
          and(eq(joinedBeds.bed1Id, bed2Id), eq(joinedBeds.bed2Id, bed1Id))
        ),
        or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, atDate))
      )
    );
  return candidates.find((j) => coversDate(j.startDate, j.endDate, atDate)) ?? null;
}

/**
 * Unassigns (bedId = null) any bookings on `bedId` overlapping
 * [rangeStart, rangeEndBound) and returns the rows that were cleared —
 * used whenever a bed becomes the non-bookable half of a Solo Double, so
 * the caller can flag whichever guests just lost their bed.
 */
export async function unassignSoloOverlap(bedId: number, rangeStart: string, rangeEndBound: string) {
  const predicate = and(eq(bookings.bedId, bedId), lt(bookings.arrivalDate, rangeEndBound), gt(bookings.departureDate, rangeStart));
  const overlapping = await db.select().from(bookings).where(predicate);
  if (overlapping.length > 0) {
    await db.update(bookings).set({ bedId: null }).where(predicate);
  }
  return overlapping;
}
