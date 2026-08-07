import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { and, eq, gt, inArray } from "drizzle-orm";
import { findActiveJoin } from "@/lib/joined-beds";

export const dynamic = "force-dynamic";

// Ends whichever join segment covers `atDate` for this pair of beds — used
// by the grid's right-click "Split into Singles" action, which doesn't know
// the join's row id, only the two beds and the date it was clicked on.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bed1Id = Number(body.bed1Id);
  const bed2Id = Number(body.bed2Id);
  const atDate = String(body.atDate ?? "");

  if (!Number.isInteger(bed1Id) || !Number.isInteger(bed2Id) || !atDate) {
    return NextResponse.json({ error: "bed1Id, bed2Id and atDate are required" }, { status: 400 });
  }

  const active = await findActiveJoin(bed1Id, bed2Id, atDate);
  if (!active) {
    return NextResponse.json({ error: "No active join covers that date" }, { status: 404 });
  }

  // Splitting is the reverse of joining — un-pushing two mattresses apart —
  // so it's just as much a physical bed-type change as joining is (see
  // POST /api/joined-beds' own guard). Someone still booked into either
  // bed PAST the split point is relying on the merged configuration
  // staying merged for the rest of their stay; a booking that's already
  // over by atDate (departing on or before it) isn't affected either way.
  const [blocker] = await db
    .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(inArray(bookings.bedId, [bed1Id, bed2Id]), gt(bookings.departureDate, atDate)));
  if (blocker) {
    return NextResponse.json(
      {
        error: `${blocker.guestName} is booked in one of these beds through ${blocker.departureDate} — split or move that booking first, then split these beds.`,
      },
      { status: 400 }
    );
  }

  await logChange({ category: "grid", action: "Split beds", summary: `Split a ${active.mode === "solo" ? "Solo Double" : "Couple Double"} back into 2 Singles, from ${atDate}` });

  if (active.startDate === atDate) {
    // Splitting on the exact day it started leaves nothing behind — delete
    // rather than leave a zero-length row.
    await db.delete(joinedBeds).where(eq(joinedBeds.id, active.id));
    return NextResponse.json({ deleted: true, id: active.id });
  }

  const [updated] = await db
    .update(joinedBeds)
    .set({ endDate: atDate })
    .where(eq(joinedBeds.id, active.id))
    .returning();
  return NextResponse.json(updated);
}
