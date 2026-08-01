import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { beds, bedLocations, bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

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

  if (!Number.isInteger(bed1Id) || !Number.isInteger(bed2Id) || bed1Id === bed2Id) {
    return NextResponse.json({ error: "Two different beds are required" }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: "Mode must be 'double' or 'solo'" }, { status: 400 });
  }
  if (endDate && endDate <= startDate) {
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });
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

  const newEndBound = endDate ?? FAR_FUTURE;
  const existingJoins = await db
    .select({ bed1Id: joinedBeds.bed1Id, bed2Id: joinedBeds.bed2Id, startDate: joinedBeds.startDate, endDate: joinedBeds.endDate })
    .from(joinedBeds)
    .where(or(eq(joinedBeds.bed1Id, bed1Id), eq(joinedBeds.bed2Id, bed1Id), eq(joinedBeds.bed1Id, bed2Id), eq(joinedBeds.bed2Id, bed2Id)));
  const overlaps = existingJoins.some((j) => {
    const involvesEither = [j.bed1Id, j.bed2Id].includes(bed1Id) || [j.bed1Id, j.bed2Id].includes(bed2Id);
    if (!involvesEither) return false;
    const jEndBound = j.endDate ?? FAR_FUTURE;
    return j.startDate < newEndBound && jEndBound > startDate;
  });
  if (overlaps) {
    return NextResponse.json({ error: "One of these beds is already joined to another bed for an overlapping date range" }, { status: 409 });
  }

  const [join] = await db
    .insert(joinedBeds)
    .values({ bed1Id, bed2Id, startDate, endDate, mode })
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

  return NextResponse.json({ ...join, unassignedBookings }, { status: 201 });
}
