import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The reverse of /api/bookings/[id]/split: merges two back-to-back
// bookings for the SAME guest in the SAME bed into one continuous stay —
// the earlier booking's departureDate becomes the later one's
// departureDate, and the later booking row is deleted outright. Order of
// {id} vs otherBookingId in the request doesn't matter — arrivalDate
// decides which is "earlier".
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const otherId = Number(body.otherBookingId);

  const [a] = await db.select().from(bookings).where(eq(bookings.id, Number(id)));
  const [b] = await db.select().from(bookings).where(eq(bookings.id, otherId));
  if (!a || !b) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  if (a.bedId == null || a.bedId !== b.bedId) {
    return NextResponse.json({ error: "Both bookings must be in the same bed" }, { status: 400 });
  }
  if (a.guestName.trim().toLowerCase() !== b.guestName.trim().toLowerCase()) {
    return NextResponse.json({ error: "Guest names must match to merge" }, { status: 400 });
  }

  const [earlier, later] = a.arrivalDate <= b.arrivalDate ? [a, b] : [b, a];
  if (earlier.departureDate !== later.arrivalDate) {
    return NextResponse.json({ error: "Bookings must be back-to-back to merge" }, { status: 400 });
  }

  const [updated] = await db
    .update(bookings)
    .set({ departureDate: later.departureDate })
    .where(eq(bookings.id, earlier.id))
    .returning();

  const [deletedSnapshot] = await db.delete(bookings).where(eq(bookings.id, later.id)).returning();

  return NextResponse.json({ updated, deletedSnapshot });
}
