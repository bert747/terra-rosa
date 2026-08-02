import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Splits a joined pair back into two independent beds, ending the join today
// (not deleting it, so the pairing stays in history — same convention as
// bed_locations).
export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const today = new Date().toISOString().slice(0, 10);

  const [existing] = await db.select().from(joinedBeds).where(eq(joinedBeds.id, Number(id)));
  if (!existing) return NextResponse.json({ error: "Join not found" }, { status: 404 });

  // Ending a join is a structural bed change like a move — block it if a
  // booking on either bed already spans THROUGH today (mid-stay). Split the
  // booking first, then split the join.
  const [spanning] = await db
    .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(inArray(bookings.bedId, [existing.bed1Id, existing.bed2Id]), lt(bookings.arrivalDate, today), gt(bookings.departureDate, today)));
  if (spanning) {
    return NextResponse.json(
      {
        error: `${spanning.guestName}'s booking (${spanning.arrivalDate} to ${spanning.departureDate}) spans through today — split the booking first, then split this join.`,
      },
      { status: 400 }
    );
  }

  const [join] = await db
    .update(joinedBeds)
    .set({ endDate: today })
    .where(eq(joinedBeds.id, Number(id)))
    .returning();

  if (!join) return NextResponse.json({ error: "Join not found" }, { status: 404 });
  return NextResponse.json(join);
}

// Deletes a join row outright — unlike PATCH above, this doesn't keep it
// around as ended history. Used by the grid's undo stack to cleanly reverse
// a "Join as New" action (POST /api/joined-beds) by removing exactly the
// row it created, identified by id rather than by (bed1Id, bed2Id, atDate)
// the way the other join routes look things up.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const [join] = await db.delete(joinedBeds).where(eq(joinedBeds.id, Number(id))).returning();
  if (!join) return NextResponse.json({ error: "Join not found" }, { status: 404 });
  return NextResponse.json(join);
}
