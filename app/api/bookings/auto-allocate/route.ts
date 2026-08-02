import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bedLocations, bookings } from "@/db/schema";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";
import { findAvailableBeds } from "@/lib/available-beds";
import { addDays } from "@/lib/occupancy";

export const dynamic = "force-dynamic";

// Manual, reviewable bulk-assignment — NOT automatic on booking creation.
// Fills in a real bed for every currently-unassigned booking arriving
// within the next `withinDays` days, one at a time in arrival order, so
// staff can glance at the result and fix up anything that landed oddly
// (see the "Needs a bed" panel on the grid, which triggers this and shows
// what changed). Bookings without a fit are left alone and reported back,
// not silently skipped.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const withinDays = Number.isInteger(body.withinDays) && body.withinDays > 0 ? body.withinDays : 7;

  const today = new Date().toISOString().slice(0, 10);
  const windowEnd = addDays(today, withinDays);

  const candidates = await db
    .select()
    .from(bookings)
    .where(and(isNull(bookings.bedId), gte(bookings.arrivalDate, today), lt(bookings.arrivalDate, windowEnd)))
    .orderBy(bookings.arrivalDate);

  const assigned: { id: number; guestName: string; bedId: number; roomName: string }[] = [];
  const skipped: { id: number; guestName: string; reason: string }[] = [];

  for (const booking of candidates) {
    // "Sleeps near" preference: try the linked booking's room first.
    let nearRoomId: number | null = null;
    if (booking.linkedBookingId != null) {
      const [linked] = await db.select({ bedId: bookings.bedId }).from(bookings).where(eq(bookings.id, booking.linkedBookingId));
      if (linked?.bedId != null) {
        const locationRows = await db.select().from(bedLocations).where(eq(bedLocations.bedId, linked.bedId));
        const active = locationRows.find(
          (r) => r.startDate <= booking.arrivalDate && (r.endDate == null || r.endDate > booking.arrivalDate)
        );
        nearRoomId = active?.roomId ?? null;
      }
    }

    let candidateBeds = nearRoomId != null
      ? await findAvailableBeds({ arrivalDate: booking.arrivalDate, departureDate: booking.departureDate, excludeBookingId: booking.id, nearRoomId })
      : [];
    if (candidateBeds.length === 0) {
      candidateBeds = await findAvailableBeds({ arrivalDate: booking.arrivalDate, departureDate: booking.departureDate, excludeBookingId: booking.id });
    }

    if (candidateBeds.length === 0) {
      skipped.push({ id: booking.id, guestName: booking.guestName, reason: "No free bed fits these dates." });
      continue;
    }

    const chosen = [...candidateBeds].sort((a, b) => a.id - b.id)[0];
    const check = await checkBedCapacity(chosen.id, booking.arrivalDate, booking.departureDate, [booking.id]);
    if (!check.ok) {
      skipped.push({ id: booking.id, guestName: booking.guestName, reason: check.error ?? "Bed no longer available." });
      continue;
    }

    await db.update(bookings).set({ bedId: chosen.id }).where(eq(bookings.id, booking.id));
    assigned.push({ id: booking.id, guestName: booking.guestName, bedId: chosen.id, roomName: chosen.roomName });
  }

  return NextResponse.json({ assigned, skipped });
}
