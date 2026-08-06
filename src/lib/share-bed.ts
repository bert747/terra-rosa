import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { bedLocations, beds, bookings, joinedBeds } from "@/db/schema";
import { checkBedCapacity } from "@/lib/booking-guard";
import { nextTimelineEventDate } from "@/lib/next-timeline-event";

export type PairResult = { ok: true; bedId: number | null } | { ok: false; error: string };

/**
 * "Shares Bed With" (coupled allocation): `anchorBookingId` already has a
 * Single bed picked. Finds the next free Single bed in the SAME ROOM
 * ("next bed down" — beds sort by ascending id within a room, see
 * sortRoomUnits in src/lib/grid.ts), assigns it to `newBookingId`, joins
 * the two beds into a "double" until the next scheduled timeline event for
 * either bed, and symmetrically links both bookings via
 * sharesBedWithBookingId. Shared by POST /api/bookings/[id]/share-bed (the
 * manual form flow, where the anchor is "this booking" and the new one is
 * the picked partner) and POST /api/bookings/auto-allocate (where the
 * anchor is an already-placed "shares bed with" target and the new one is
 * the unassigned candidate being allocated) — same operation either way,
 * just which side already has a bed.
 *
 * `requireBed` (default true) controls what happens when no free partner
 * bed exists: auto-allocate is placing a previously UNassigned booking, so
 * "no bed found" has to stay a hard failure there (ok:false — the booking
 * still has nowhere to sleep, and the caller falls back to proposing a
 * group move instead). The manual "Shares Bed With" form, though, is
 * usually applied to a booking that already HAS a bed elsewhere — in that
 * case there's no reason to block saving the relationship itself just
 * because a same-room bed isn't free right now; the grid's own ⚠ alert icon
 * already exists to flag exactly that mismatch until staff resolve it
 * (Fix/move). Pass `requireBed: false` for that path.
 */
export async function pairWithAnchor(anchorBookingId: number, newBookingId: number, options?: { requireBed?: boolean }): Promise<PairResult> {
  const requireBed = options?.requireBed ?? true;
  const [anchor] = await db.select().from(bookings).where(eq(bookings.id, anchorBookingId));
  const [newBooking] = await db.select().from(bookings).where(eq(bookings.id, newBookingId));
  if (!anchor || !newBooking) return { ok: false, error: "Booking not found" };
  if (anchor.bedId == null) return { ok: false, error: "The anchor booking needs a bed picked first" };

  const [bed] = await db.select().from(beds).where(eq(beds.id, anchor.bedId));
  if (!bed || bed.type.toLowerCase() !== "single") {
    return { ok: false, error: "Shares Bed With requires a Single bed" };
  }

  const [placement] = await db
    .select({ roomId: bedLocations.roomId })
    .from(bedLocations)
    .where(and(eq(bedLocations.bedId, anchor.bedId), isNull(bedLocations.endDate)));
  if (!placement) return { ok: false, error: "This bed isn't placed in a room" };

  const roomBeds = await db
    .select({ bedId: bedLocations.bedId, type: beds.type })
    .from(bedLocations)
    .innerJoin(beds, eq(beds.id, bedLocations.bedId))
    .where(and(eq(bedLocations.roomId, placement.roomId), isNull(bedLocations.endDate)));

  const candidateIds = roomBeds
    .filter((b) => b.bedId !== anchor.bedId && b.type.toLowerCase() === "single")
    .map((b) => b.bedId)
    .sort((a, b2) => {
      // Prefer the next bed DOWN (nearest higher id) before falling back to
      // the nearest lower one.
      const aDown = a > anchor.bedId!;
      const bDown = b2 > anchor.bedId!;
      if (aDown !== bDown) return aDown ? -1 : 1;
      return Math.abs(a - anchor.bedId!) - Math.abs(b2 - anchor.bedId!);
    });

  const startDate = anchor.arrivalDate < newBooking.arrivalDate ? anchor.arrivalDate : newBooking.arrivalDate;

  let chosenBedId: number | null = null;
  for (const candidateId of candidateIds) {
    const check = await checkBedCapacity(candidateId, newBooking.arrivalDate, newBooking.departureDate, [newBookingId]);
    if (check.ok) {
      chosenBedId = candidateId;
      break;
    }
  }
  if (chosenBedId == null) {
    if (requireBed) return { ok: false, error: "No free Single bed available in the same room to pair with" };
    // No free bed to actually move them into right now, but the caller
    // doesn't need one (see requireBed's own doc comment) — record the
    // relationship anyway (both sides, same as the successful path below)
    // rather than failing the whole save. The grid's own ⚠ alert icon
    // already exists specifically for this: a "shares bed with" pairing
    // that ISN'T currently being met, for staff to resolve manually
    // (Fix/move) once a bed frees up, instead of the intent being silently
    // dropped because none was free at save time.
    await db.transaction(async (tx) => {
      await tx.update(bookings).set({ sharesBedWithBookingId: anchorBookingId }).where(eq(bookings.id, newBookingId));
      await tx.update(bookings).set({ sharesBedWithBookingId: newBookingId }).where(eq(bookings.id, anchorBookingId));
    });
    return { ok: true, bedId: null };
  }

  const endDate = await nextTimelineEventDate([anchor.bedId, chosenBedId], startDate);

  await db.transaction(async (tx) => {
    await tx.update(bookings).set({ bedId: chosenBedId, sharesBedWithBookingId: anchorBookingId }).where(eq(bookings.id, newBookingId));
    await tx.update(bookings).set({ sharesBedWithBookingId: newBookingId }).where(eq(bookings.id, anchorBookingId));
    await tx.insert(joinedBeds).values({ bed1Id: anchor.bedId!, bed2Id: chosenBedId!, startDate, endDate, mode: "double" });
  });

  return { ok: true, bedId: chosenBedId };
}
