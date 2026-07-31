import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rooms, stayRoomSegments } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { checkRoomAvailabilityForRange } from "@/lib/room-availability";
import { roomCapacitiesForDates } from "@/lib/occupancy";

export const dynamic = "force-dynamic";

// Segments implement room moves: a booking can have several segments across
// different rooms/date-ranges. No exclusion constraint blocks overlaps here
// on purpose — multi-bed/dorm rooms legitimately hold guests from several
// bookings at once. Capacity conflicts are surfaced via aggregation in
// src/lib/occupancy.ts (roomStatusesForDate), not by blocking inserts.

export async function GET(req: NextRequest) {
  const bookingId = req.nextUrl.searchParams.get("bookingId");
  const query = db.select().from(stayRoomSegments);
  const rows = bookingId
    ? await query.where(eq(stayRoomSegments.bookingId, Number(bookingId)))
    : await query;
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bookingId = Number(body.bookingId);
  const roomId = Number(body.roomId);
  const startDate = String(body.startDate ?? "");
  const endDate = String(body.endDate ?? "");
  const guestCount = Number(body.guestCount ?? 1);
  const preferredBed = body.preferredBed ? Number(body.preferredBed) : null;

  if (!bookingId || !roomId || !startDate || !endDate) {
    return NextResponse.json({ error: "bookingId, roomId, startDate and endDate are required" }, { status: 400 });
  }
  if (startDate >= endDate) {
    return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Selected room is not available." }, { status: 400 });
  }

  const existingSegments = await db
    .select()
    .from(stayRoomSegments)
    .where(eq(stayRoomSegments.bookingId, bookingId));

  // If this move starts during an existing segment, close that segment at
  // move start so the booking cannot occupy old and new rooms at the same time.
  const segmentToClose = existingSegments
    .filter((segment) => segment.startDate < startDate && segment.endDate > startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id)
    .at(-1);

  const wouldOverlapAnotherSegment = existingSegments.some((segment) => {
    if (segmentToClose && segment.id === segmentToClose.id) return false;
    return segment.startDate < endDate && segment.endDate > startDate;
  });

  if (wouldOverlapAnotherSegment) {
    return NextResponse.json(
      { error: "Room move overlaps another segment for this booking. Shift dates first or edit existing segments." },
      { status: 409 }
    );
  }

  const availability = await checkRoomAvailabilityForRange({
    roomId,
    startDate,
    endDate,
    guestCount,
  });
  if (!availability.ok) {
    return NextResponse.json(
      { error: availability.message ?? "Selected room is unavailable for these dates." },
      { status: 409 }
    );
  }

  if (preferredBed && preferredBed > 0) {
    const dates: string[] = [];
    for (let d = startDate; d < endDate; d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)) {
      dates.push(d);
    }
    const capacities = await roomCapacitiesForDates(dates);
    const minCapacity = Math.min(...(capacities.get(roomId) ?? [0]));
    if (preferredBed > minCapacity) {
      return NextResponse.json(
        { error: "Preferred bed is unavailable for part of this stay." },
        { status: 409 }
      );
    }
  }

  if (segmentToClose) {
    await db
      .update(stayRoomSegments)
      .set({ endDate: startDate })
      .where(eq(stayRoomSegments.id, segmentToClose.id));
  }

  const [row] = await db
    .insert(stayRoomSegments)
    .values({
      bookingId,
      roomId,
      startDate,
      endDate,
      guestCount,
      preferredBed: preferredBed && preferredBed > 0 ? preferredBed : null,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
