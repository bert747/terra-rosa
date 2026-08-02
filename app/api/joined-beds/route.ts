import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { beds, bedLocations, bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { and, eq, gt, isNull, inArray, lt, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

const FAR_FUTURE = "9999-12-31";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function coversDate(startDate: string, endDate: string | null, date: string): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

// Joins that haven't fully ended yet — currently active or scheduled for a
// future start. The settings page uses this both to grey out beds already
// spoken for and to show upcoming joins so staff can see what's planned.
export async function GET() {
  const today = todayISO();
  const rows = await db
    .select({
      id: joinedBeds.id,
      bed1Id: joinedBeds.bed1Id,
      bed2Id: joinedBeds.bed2Id,
      startDate: joinedBeds.startDate,
      endDate: joinedBeds.endDate,
      mode: joinedBeds.mode,
    })
    .from(joinedBeds)
    .where(or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, today)));
  return NextResponse.json(rows);
}

// Joins two independent "Single" beds — in the same room as of `startDate` —
// into a Double (sleeps 2, no capacity change) or a Solo Double (sleeps 1,
// the second bed stops being independently bookable for the join's range).
// `startDate` defaults to today; pass a future date to plan a join ahead
// without touching the present layout. Any of the second bed's existing
// bookings that overlap a Solo Double's range are unassigned (bed_id = null)
// and returned so the caller can flag them.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bed1Id = Number(body.bed1Id);
  const bed2Id = Number(body.bed2Id);
  const mode = body.mode === "solo" ? "solo" : body.mode === "double" ? "double" : null;
  const startDate = String(body.startDate ?? todayISO());
  const endDate = body.endDate ? String(body.endDate) : null;
  // Only set once the caller has confirmed how to handle a GENUINE future
  // join collision for this exact bed pair (see the `samePairConflict`
  // block below) — without one, that case is reported back as a 409 rather
  // than silently resolved, so the grid can show the Overwrite/Trim prompt.
  const resolution = body.resolution === "overwrite" ? "overwrite" : body.resolution === "trim" ? "trim" : null;

  if (!Number.isInteger(bed1Id) || !Number.isInteger(bed2Id) || bed1Id === bed2Id) {
    return NextResponse.json({ error: "Two different beds are required" }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: "Mode must be 'double' or 'solo'" }, { status: 400 });
  }
  if (endDate && endDate <= startDate) {
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });
  }

  // Joining is a structural bed change like a move or a type change — block
  // it if a booking on either bed already spans THROUGH startDate (mid-stay,
  // not just starting there). Split the booking first, then join.
  const [spanning] = await db
    .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(inArray(bookings.bedId, [bed1Id, bed2Id]), lt(bookings.arrivalDate, startDate), gt(bookings.departureDate, startDate)));
  if (spanning) {
    return NextResponse.json(
      {
        error: `${spanning.guestName}'s booking (${spanning.arrivalDate} to ${spanning.departureDate}) spans through ${startDate} — split the booking first, then join these beds.`,
      },
      { status: 400 }
    );
  }

  const bedRows = await db.select().from(beds).where(or(eq(beds.id, bed1Id), eq(beds.id, bed2Id)));
  const bed1 = bedRows.find((b) => b.id === bed1Id);
  const bed2 = bedRows.find((b) => b.id === bed2Id);
  if (!bed1 || !bed2) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  if (bed1.type.toLowerCase() !== "single" || bed2.type.toLowerCase() !== "single") {
    return NextResponse.json({ error: "Only two Single beds can be joined" }, { status: 400 });
  }

  const locationRows = await db
    .select({ bedId: bedLocations.bedId, roomId: bedLocations.roomId, startDate: bedLocations.startDate, endDate: bedLocations.endDate })
    .from(bedLocations)
    .where(or(eq(bedLocations.bedId, bed1Id), eq(bedLocations.bedId, bed2Id)));
  const room1 = locationRows.find((l) => l.bedId === bed1Id && coversDate(l.startDate, l.endDate, startDate))?.roomId;
  const room2 = locationRows.find((l) => l.bedId === bed2Id && coversDate(l.startDate, l.endDate, startDate))?.roomId;
  if (!room1 || !room2) {
    return NextResponse.json({ error: "Both beds must be placed in a room as of the start date" }, { status: 400 });
  }
  if (room1 !== room2) {
    return NextResponse.json({ error: "Beds must be in the same room to be joined" }, { status: 400 });
  }

  const requestedEndBound = endDate ?? FAR_FUTURE;
  const existingJoins = await db
    .select({ id: joinedBeds.id, bed1Id: joinedBeds.bed1Id, bed2Id: joinedBeds.bed2Id, startDate: joinedBeds.startDate, endDate: joinedBeds.endDate })
    .from(joinedBeds)
    .where(or(eq(joinedBeds.bed1Id, bed1Id), eq(joinedBeds.bed2Id, bed1Id), eq(joinedBeds.bed1Id, bed2Id), eq(joinedBeds.bed2Id, bed2Id)));
  // Half-open interval overlap: [j.startDate, jEndBound) vs
  // [startDate, requestedEndBound). A null endDate means "ongoing
  // indefinitely", not "no conflict" — it genuinely extends to FAR_FUTURE.
  const conflicts = existingJoins
    .filter((j) => {
      const jEndBound = j.endDate ?? FAR_FUTURE;
      return j.startDate < requestedEndBound && jEndBound > startDate;
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  let effectiveEndDate = endDate;
  let overwrittenJoin: (typeof existingJoins)[number] | null = null;
  if (conflicts.length > 0) {
    // A conflict that has ALREADY STARTED as of `startDate` (or starts
    // exactly then) can't be resolved by trimming the new join's end —
    // something is genuinely sitting on top of the requested start date.
    const blocking = conflicts.find((j) => j.startDate <= startDate);
    if (blocking) {
      return NextResponse.json(
        {
          error: `Already joined from ${blocking.startDate} to ${blocking.endDate ?? "indefinitely"}`,
          conflict: { startDate: blocking.startDate, endDate: blocking.endDate },
        },
        { status: 409 }
      );
    }

    // A GENUINE future collision — this exact bed pair already has a join
    // scheduled to start later — gets an interactive Overwrite/Trim prompt
    // instead of a silent trim. A conflict against a DIFFERENT partner for
    // one of these beds is a rarer, pre-existing edge case and keeps the
    // old silent snap-to-boundary behaviour below (out of scope here).
    const samePairConflict = conflicts.find(
      (j) => (j.bed1Id === bed1Id && j.bed2Id === bed2Id) || (j.bed1Id === bed2Id && j.bed2Id === bed1Id)
    );

    if (samePairConflict && !resolution) {
      return NextResponse.json(
        {
          error: `Already joined from ${samePairConflict.startDate} to ${samePairConflict.endDate ?? "indefinitely"}`,
          futureConflict: { id: samePairConflict.id, startDate: samePairConflict.startDate, endDate: samePairConflict.endDate },
        },
        { status: 409 }
      );
    }

    if (samePairConflict && resolution === "overwrite") {
      await db.delete(joinedBeds).where(eq(joinedBeds.id, samePairConflict.id));
      overwrittenJoin = samePairConflict;
      // Other (different-partner) conflicts, if any remain, still apply
      // the usual snap-to-boundary trim.
      const remaining = conflicts.filter((j) => j.id !== samePairConflict.id);
      effectiveEndDate = remaining.length > 0 ? (endDate && endDate < remaining[0].startDate ? endDate : remaining[0].startDate) : endDate;
    } else {
      // Explicit "trim" resolution, or no same-pair conflict at all (only a
      // different-partner one) — rather than reject the whole join, quietly
      // bound it to end right before the earliest conflict begins, so the
      // two sit cleanly adjacent.
      const earliestConflictStart = conflicts[0].startDate;
      effectiveEndDate = endDate && endDate < earliestConflictStart ? endDate : earliestConflictStart;
    }
  }
  const newEndBound = effectiveEndDate ?? FAR_FUTURE;

  const [join] = await db
    .insert(joinedBeds)
    .values({ bed1Id, bed2Id, startDate, endDate: effectiveEndDate, mode })
    .returning();

  let unassignedBookings: (typeof bookings.$inferSelect)[] = [];
  if (mode === "solo") {
    unassignedBookings = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.bedId, bed2Id), lt(bookings.arrivalDate, newEndBound), gt(bookings.departureDate, startDate)));
    if (unassignedBookings.length > 0) {
      await db
        .update(bookings)
        .set({ bedId: null })
        .where(and(eq(bookings.bedId, bed2Id), lt(bookings.arrivalDate, newEndBound), gt(bookings.departureDate, startDate)));
    }
  }

  return NextResponse.json({ ...join, unassignedBookings, overwrittenJoin }, { status: 201 });
}
