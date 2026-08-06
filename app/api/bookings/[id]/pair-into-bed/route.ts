import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";

export const dynamic = "force-dynamic";

// Confirmed by the grid's "share bed?" prompt (see the DropValidity ===
// "valid-shares" branch in GridCanvas.tsx) — the ONLY way two bookings ever
// end up sharing a bed's spare slot on a native Queen/1.5/Double or an
// already-joined pair. Moving a booking there via a plain PATCH would leave
// it silently co-occupying a stranger's bed with no record the pairing was
// deliberate; this always sets sharesBedWithBookingId on both sides too.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bookingId = Number(id);
  const body = await req.json().catch(() => ({}));
  const otherBookingId = Number(body.otherBookingId);
  const bedId = Number(body.bedId);
  const arrivalDate = String(body.arrivalDate ?? "");
  const departureDate = String(body.departureDate ?? "");

  if (!Number.isInteger(otherBookingId) || !Number.isInteger(bedId) || !arrivalDate || !departureDate) {
    return NextResponse.json({ error: "otherBookingId, bedId, arrivalDate and departureDate are required" }, { status: 400 });
  }
  if (departureDate <= arrivalDate) {
    return NextResponse.json({ error: "Departure date must be after arrival date" }, { status: 400 });
  }

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  const [other] = await db.select().from(bookings).where(eq(bookings.id, otherBookingId));
  if (!booking || !other) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const capacityCheck = await checkBedCapacity(bedId, arrivalDate, departureDate, [bookingId]);
  if (!capacityCheck.ok) {
    return NextResponse.json({ error: capacityCheck.error }, { status: 409 });
  }

  const previousBookingShares = booking.sharesBedWithBookingId;
  const previousOtherShares = other.sharesBedWithBookingId;

  await db.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({ bedId, arrivalDate, departureDate, sharesBedWithBookingId: otherBookingId })
      .where(eq(bookings.id, bookingId));
    await tx.update(bookings).set({ sharesBedWithBookingId: bookingId }).where(eq(bookings.id, otherBookingId));
  });

  return NextResponse.json({ ok: true, previousBookingShares, previousOtherShares });
}
