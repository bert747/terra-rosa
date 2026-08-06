import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Splits a joined pair back into two independent beds, ending the join —
// defaults to today (not deleting the row, so the pairing stays in history,
// same convention as bed_locations) but also accepts an explicit `endDate`
// in the body: a specific future date (restoring a planned end — see the
// grid's "Planned Changes" undo) or `null` (clearing a scheduled end,
// cancelling that plan and making the join open-ended again).
//
// A body with `startDate` instead reschedules when a not-yet-started join
// begins — used by the Planned Changes panel's "Delay" action (and its own
// undo/redo), which pushes a join-start's effective date out rather than
// cancelling it outright when an existing booking is still relying on the
// pre-join setup past the originally planned date. Only one of
// startDate/endDate is ever sent in a single call.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const today = new Date().toISOString().slice(0, 10);
  const body = await req.json().catch(() => ({}));
  const hasStartDate = Object.prototype.hasOwnProperty.call(body, "startDate");

  const [existing] = await db.select().from(joinedBeds).where(eq(joinedBeds.id, Number(id)));
  if (!existing) return NextResponse.json({ error: "Join not found" }, { status: 404 });

  if (hasStartDate) {
    const startDate = String(body.startDate);
    if (existing.endDate != null && startDate >= existing.endDate) {
      return NextResponse.json({ error: "Start date must be before the join's end date" }, { status: 400 });
    }
    // Same physical-bed-type-change rule POST /api/joined-beds enforces —
    // rescheduling WHEN a join starts is just moving that same structural
    // change to a different date, so it can't land on a date either bed
    // already has a booking spanning through, same as creating it fresh.
    const [spanning] = await db
      .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
      .from(bookings)
      .where(and(inArray(bookings.bedId, [existing.bed1Id, existing.bed2Id]), lt(bookings.arrivalDate, startDate), gt(bookings.departureDate, startDate)));
    if (spanning) {
      return NextResponse.json(
        {
          error: `${spanning.guestName}'s booking (${spanning.arrivalDate} to ${spanning.departureDate}) spans through ${startDate} — split the booking first, then reschedule this join.`,
        },
        { status: 400 }
      );
    }
    const [join] = await db.update(joinedBeds).set({ startDate }).where(eq(joinedBeds.id, Number(id))).returning();
    if (!join) return NextResponse.json({ error: "Join not found" }, { status: 404 });
    return NextResponse.json(join);
  }

  const hasEndDate = Object.prototype.hasOwnProperty.call(body, "endDate");
  const endDate: string | null = hasEndDate ? (body.endDate ? String(body.endDate) : null) : today;

  if (endDate != null && endDate <= existing.startDate) {
    return NextResponse.json({ error: "End date must be after the join's start date" }, { status: 400 });
  }

  // Ending (or re-ending) a join is a structural bed change like a move —
  // block it if a booking on either bed already spans THROUGH the target
  // end date (mid-stay). Split the booking first, then split the join.
  if (endDate != null) {
    const [spanning] = await db
      .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
      .from(bookings)
      .where(and(inArray(bookings.bedId, [existing.bed1Id, existing.bed2Id]), lt(bookings.arrivalDate, endDate), gt(bookings.departureDate, endDate)));
    if (spanning) {
      return NextResponse.json(
        {
          error: `${spanning.guestName}'s booking (${spanning.arrivalDate} to ${spanning.departureDate}) spans through ${endDate} — split the booking first, then split this join.`,
        },
        { status: 400 }
      );
    }
  }

  const [join] = await db
    .update(joinedBeds)
    .set({ endDate })
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
