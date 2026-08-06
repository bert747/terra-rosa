import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bedLocations, bookings, beds, rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Places a bed in a room starting `startDate` (defaults to today — plan a
// move ahead by passing a future date, which leaves the present layout
// untouched until then). Any existing placement that would overlap the new
// one is truncated to end exactly when the new one begins, or deleted
// outright if it hadn't started yet, so a bed is never in two rooms at once.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bedId = Number(body.bedId);
  const roomId = Number(body.roomId);
  const startDate = String(body.startDate ?? todayISO());
  const endDate = body.endDate ? String(body.endDate) : null;

  if (!Number.isInteger(bedId) || bedId <= 0) {
    return NextResponse.json({ error: "A bed is required" }, { status: 400 });
  }
  if (!Number.isInteger(roomId) || roomId <= 0) {
    return NextResponse.json({ error: "A room is required" }, { status: 400 });
  }
  if (endDate && endDate <= startDate) {
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });
  }

  // A bed move is a structural change with no natural "in progress" state —
  // it's only ever clean if startDate lands either on a night this bed is
  // free, or exactly on some booking's own arrivalDate. A booking that
  // spans THROUGH startDate (arrivalDate < startDate < departureDate) would
  // otherwise get silently carried into the new room/layout mid-stay —
  // split it into two bookings first so the move lands on a real boundary.
  const [spanning] = await db
    .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(eq(bookings.bedId, bedId), lt(bookings.arrivalDate, startDate), gt(bookings.departureDate, startDate)));
  if (spanning) {
    return NextResponse.json(
      {
        error: `${spanning.guestName}'s booking (${spanning.arrivalDate} to ${spanning.departureDate}) spans through this date — split the booking first, then move the bed.`,
      },
      { status: 400 }
    );
  }

  const conflicting = await db
    .select()
    .from(bedLocations)
    .where(
      and(eq(bedLocations.bedId, bedId), or(isNull(bedLocations.endDate), gt(bedLocations.endDate, startDate)))
    );

  for (const row of conflicting) {
    if (row.startDate >= startDate) {
      await db.delete(bedLocations).where(eq(bedLocations.id, row.id));
    } else {
      await db.update(bedLocations).set({ endDate: startDate }).where(eq(bedLocations.id, row.id));
    }
  }

  const [location] = await db
    .insert(bedLocations)
    .values({ bedId, roomId, startDate, endDate })
    .returning();

  const [bed] = await db.select({ type: beds.type }).from(beds).where(eq(beds.id, bedId));
  const [room] = await db.select({ name: rooms.name }).from(rooms).where(eq(rooms.id, roomId));
  await logChange({
    category: "grid",
    action: "Moved bed",
    summary: `Moved ${bed?.type ?? "a bed"} to ${room?.name ?? "a room"}, from ${startDate}`,
  });

  return NextResponse.json(location, { status: 201 });
}
