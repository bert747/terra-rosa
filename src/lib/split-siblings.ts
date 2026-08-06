import { db } from "@/db";
import { bookings } from "@/db/schema";
import { eq, isNotNull } from "drizzle-orm";
import type { ISODate } from "@/lib/occupancy";

export interface SplitSiblingBooking {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
  bedId: number | null;
}

/**
 * Every split lineage in the system, keyed by splitGroupId, each list
 * sorted by arrivalDate (so index 0 is always the earliest piece). Loaded
 * globally rather than scoped to a date window — same reasoning as
 * findPlannedChanges: a sibling can sit anywhere on the calendar, so the
 * grid pill's own "jump to the other part" arrows need to know where it is
 * even when it's nowhere near what's currently on screen.
 */
export async function loadAllSplitGroups(): Promise<Map<number, SplitSiblingBooking[]>> {
  const rows = await db
    .select({
      id: bookings.id,
      splitGroupId: bookings.splitGroupId,
      guestName: bookings.guestName,
      arrivalDate: bookings.arrivalDate,
      departureDate: bookings.departureDate,
      bedId: bookings.bedId,
    })
    .from(bookings)
    .where(isNotNull(bookings.splitGroupId));

  const byGroup = new Map<number, SplitSiblingBooking[]>();
  for (const r of rows) {
    const groupId = r.splitGroupId!;
    const list = byGroup.get(groupId) ?? [];
    list.push({ id: r.id, guestName: r.guestName, arrivalDate: r.arrivalDate, departureDate: r.departureDate, bedId: r.bedId });
    byGroup.set(groupId, list);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
  return byGroup;
}

/** Every OTHER booking in `bookingId`'s split lineage, earliest first — empty if it was never split. */
export async function findSplitSiblings(bookingId: number): Promise<SplitSiblingBooking[]> {
  const [booking] = await db.select({ splitGroupId: bookings.splitGroupId }).from(bookings).where(eq(bookings.id, bookingId));
  if (!booking?.splitGroupId) return [];

  const rows = await db
    .select({ id: bookings.id, guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate, bedId: bookings.bedId })
    .from(bookings)
    .where(eq(bookings.splitGroupId, booking.splitGroupId));

  return rows.filter((r) => r.id !== bookingId).sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
}
