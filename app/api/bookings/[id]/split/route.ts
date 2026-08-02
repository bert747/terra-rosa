import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Splits one booking into two independent, back-to-back bookings in the
// same bed — used when a guest changes rooms mid-stay: the original keeps
// its arrival date but its departureDate becomes `splitDate`, and a new
// booking is created for the remainder (splitDate -> original departureDate)
// with the same guest/linked-booking/bed/dietary details, so the caller can
// then drag just the second half to a new room independently of the first.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bookingId = Number(id);
  const body = await req.json();
  const splitDate = String(body.splitDate ?? "");

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Strictly between arrival and departure — otherwise one side of the split
  // would be a zero-night booking.
  if (!splitDate || splitDate <= booking.arrivalDate || splitDate >= booking.departureDate) {
    return NextResponse.json({ error: "Split date must be strictly between arrival and departure" }, { status: 400 });
  }

  const [updated] = await db
    .update(bookings)
    .set({ departureDate: splitDate })
    .where(eq(bookings.id, bookingId))
    .returning();

  const [created] = await db
    .insert(bookings)
    .values({
      guestName: booking.guestName,
      arrivalDate: splitDate,
      departureDate: booking.departureDate,
      linkedBookingId: booking.linkedBookingId,
      bedId: booking.bedId,
      dietariesTags: booking.dietariesTags,
    })
    .returning();

  return NextResponse.json({ updated, created }, { status: 201 });
}
