import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";

export const dynamic = "force-dynamic";

// Trades two bookings' beds in one atomic move: `draggedBookingId` takes
// `toBedId` with a (possibly date-shifted) new range, and `otherBookingId`
// goes back to `fromBedId` with its OWN dates unchanged. A plain two-call
// PATCH sequence can't validate this safely — at the instant the first
// PATCH lands, the SECOND booking is still sitting in the bed the first
// one is moving into, so a naive capacity check would reject the very
// swap it's supposed to allow. Both capacity checks here explicitly
// exclude BOTH booking ids for exactly that reason (see checkBedCapacity),
// and both writes happen inside one transaction so a mid-swap failure
// can't ever leave the pair half-swapped.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const draggedBookingId = Number(body.draggedBookingId);
  const otherBookingId = Number(body.otherBookingId);
  const fromBedId = Number(body.fromBedId);
  const toBedId = Number(body.toBedId);
  const draggedArrival = String(body.draggedArrival ?? "");
  const draggedDeparture = String(body.draggedDeparture ?? "");

  if (
    !Number.isInteger(draggedBookingId) ||
    !Number.isInteger(otherBookingId) ||
    !Number.isInteger(fromBedId) ||
    !Number.isInteger(toBedId) ||
    !draggedArrival ||
    !draggedDeparture
  ) {
    return NextResponse.json({ error: "draggedBookingId, otherBookingId, fromBedId, toBedId, draggedArrival and draggedDeparture are required" }, { status: 400 });
  }

  const [other] = await db.select().from(bookings).where(eq(bookings.id, otherBookingId));
  if (!other) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const excludeIds = [draggedBookingId, otherBookingId];
  const draggedCheck = await checkBedCapacity(toBedId, draggedArrival, draggedDeparture, excludeIds);
  if (!draggedCheck.ok) return NextResponse.json({ error: draggedCheck.error }, { status: 409 });
  const otherCheck = await checkBedCapacity(fromBedId, other.arrivalDate, other.departureDate, excludeIds);
  if (!otherCheck.ok) return NextResponse.json({ error: otherCheck.error }, { status: 409 });

  const [draggedRow, otherRow] = await db.transaction(async (tx) => {
    const [d] = await tx
      .update(bookings)
      .set({ bedId: toBedId, arrivalDate: draggedArrival, departureDate: draggedDeparture })
      .where(eq(bookings.id, draggedBookingId))
      .returning();
    const [o] = await tx.update(bookings).set({ bedId: fromBedId }).where(eq(bookings.id, otherBookingId)).returning();
    return [d, o];
  });

  if (!draggedRow || !otherRow) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json({ dragged: draggedRow, other: otherRow });
}
