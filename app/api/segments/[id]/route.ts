import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rooms, stayRoomSegments } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkRoomAvailabilityForRange } from "@/lib/room-availability";
import { roomCapacitiesForDates } from "@/lib/occupancy";

export const dynamic = "force-dynamic";

// PATCH is used to edit a segment after planning a move. We prevent overlaps
// within a booking so one booking cannot occupy two rooms for the same dates.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const segmentId = Number(id);
  const body = await req.json();

  const current = await db
    .select()
    .from(stayRoomSegments)
    .where(eq(stayRoomSegments.id, segmentId))
    .limit(1);
  const existing = current[0];
  if (!existing) return NextResponse.json({ error: "Segment not found" }, { status: 404 });

  const updates: Partial<typeof stayRoomSegments.$inferInsert> = {};
  if (body.startDate !== undefined) updates.startDate = body.startDate;
  if (body.endDate !== undefined) updates.endDate = body.endDate;
  if (body.guestCount !== undefined) updates.guestCount = Number(body.guestCount);
  if (body.roomId !== undefined) updates.roomId = Number(body.roomId);
  if (body.preferredBed !== undefined) {
    const preferredBed = Number(body.preferredBed);
    updates.preferredBed = Number.isInteger(preferredBed) && preferredBed > 0 ? preferredBed : null;
  }

  const nextStartDate = updates.startDate ?? existing.startDate;
  const nextEndDate = updates.endDate ?? existing.endDate;
  const nextRoomId = updates.roomId ?? existing.roomId;
  const nextGuestCount = updates.guestCount ?? existing.guestCount;
  const nextPreferredBed = updates.preferredBed ?? existing.preferredBed;
  if (nextStartDate >= nextEndDate) {
    return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, nextRoomId)).limit(1);
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Selected room is not available." }, { status: 400 });
  }

  const siblingSegments = await db
    .select()
    .from(stayRoomSegments)
    .where(eq(stayRoomSegments.bookingId, existing.bookingId));

  const overlapsSibling = siblingSegments.some((segment) => {
    if (segment.id === existing.id) return false;
    return segment.startDate < nextEndDate && segment.endDate > nextStartDate;
  });

  if (overlapsSibling) {
    return NextResponse.json(
      { error: "Segment update would overlap another segment in this booking." },
      { status: 409 }
    );
  }

  const availability = await checkRoomAvailabilityForRange({
    roomId: nextRoomId,
    startDate: nextStartDate,
    endDate: nextEndDate,
    guestCount: nextGuestCount,
    excludeSegmentId: existing.id,
  });
  if (!availability.ok) {
    return NextResponse.json(
      { error: availability.message ?? "Selected room is unavailable for these dates." },
      { status: 409 }
    );
  }

  if (nextPreferredBed && nextPreferredBed > 0) {
    const dates: string[] = [];
    for (let d = nextStartDate; d < nextEndDate; d = new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)) {
      dates.push(d);
    }
    const capacities = await roomCapacitiesForDates(dates);
    const minCapacity = Math.min(...(capacities.get(nextRoomId) ?? [0]));
    if (nextPreferredBed > minCapacity) {
      return NextResponse.json(
        { error: "Preferred bed is unavailable for part of this stay." },
        { status: 409 }
      );
    }
  }

  const [row] = await db
    .update(stayRoomSegments)
    .set(updates)
    .where(eq(stayRoomSegments.id, segmentId))
    .returning();
  if (!row) return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }
  const { id } = await params;
  const [row] = await db
    .delete(stayRoomSegments)
    .where(eq(stayRoomSegments.id, Number(id)))
    .returning();
  if (!row) return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  return NextResponse.json(row);
}
