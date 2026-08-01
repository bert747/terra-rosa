import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

const FAR_FUTURE = "9999-12-31";

function coversDate(startDate: string, endDate: string | null, date: string): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

// Switches an ALREADY-joined pair's mode at `atDate` in one step: ends
// whichever segment currently covers that date and starts a new one there
// with the new mode — used by the grid's right-click "Switch to Couple /
// Solo Double" action on cells that are already joined (as opposed to
// POST /api/joined-beds, which creates a join from scratch).
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
  const mode = body.mode === "solo" ? "solo" : body.mode === "double" ? "double" : null;

  if (!Number.isInteger(bed1Id) || !Number.isInteger(bed2Id) || !atDate) {
    return NextResponse.json({ error: "bed1Id, bed2Id and atDate are required" }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: "Mode must be 'double' or 'solo'" }, { status: 400 });
  }

  const candidates = await db
    .select()
    .from(joinedBeds)
    .where(
      and(
        or(
          and(eq(joinedBeds.bed1Id, bed1Id), eq(joinedBeds.bed2Id, bed2Id)),
          and(eq(joinedBeds.bed1Id, bed2Id), eq(joinedBeds.bed2Id, bed1Id))
        ),
        or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, atDate))
      )
    );
  const active = candidates.find((j) => coversDate(j.startDate, j.endDate, atDate));
  if (!active) {
    return NextResponse.json({ error: "No active join covers that date" }, { status: 404 });
  }
  if (active.mode === mode) {
    return NextResponse.json({ error: `Already ${mode}` }, { status: 409 });
  }

  const priorEndDate = active.endDate;
  if (active.startDate === atDate) {
    await db.delete(joinedBeds).where(eq(joinedBeds.id, active.id));
  } else {
    await db.update(joinedBeds).set({ endDate: atDate }).where(eq(joinedBeds.id, active.id));
  }

  // Preserve bed1/bed2 orientation (isPrimary matters for "solo").
  const [created] = await db
    .insert(joinedBeds)
    .values({ bed1Id: active.bed1Id, bed2Id: active.bed2Id, startDate: atDate, endDate: priorEndDate, mode })
    .returning();

  let unassignedBookings: (typeof bookings.$inferSelect)[] = [];
  if (mode === "solo") {
    const endBound = priorEndDate ?? FAR_FUTURE;
    unassignedBookings = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.bedId, active.bed2Id), lt(bookings.arrivalDate, endBound), gt(bookings.departureDate, atDate)));
    if (unassignedBookings.length > 0) {
      await db
        .update(bookings)
        .set({ bedId: null })
        .where(and(eq(bookings.bedId, active.bed2Id), lt(bookings.arrivalDate, endBound), gt(bookings.departureDate, atDate)));
    }
  }

  return NextResponse.json({ ...created, unassignedBookings });
}
