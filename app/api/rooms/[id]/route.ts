import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { bookings, rooms, stayRoomSegments } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { ensureRoomBedsSeeded } from "@/lib/room-beds";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureRoomBedsSeeded();
  const { id } = await params;
  const roomId = Number(id);
  const room = await db.query.rooms.findFirst({
    where: eq(rooms.id, roomId),
    with: { roomBeds: true },
  });
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  return NextResponse.json(room);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ensureRoomBedsSeeded();
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const roomId = Number(id);
  const body = await req.json();

  const updates: Partial<typeof rooms.$inferInsert> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.locationOrType !== undefined) updates.locationOrType = body.locationOrType;
  if (body.defaultBedCount !== undefined) updates.defaultBedCount = Number(body.defaultBedCount);
  if (body.displayOrder !== undefined) updates.displayOrder = Number(body.displayOrder);
  if (body.isActive !== undefined) updates.isActive = Boolean(body.isActive);
  if (body.notes !== undefined) updates.notes = body.notes;

  // Archiving a room is blocked if any confirmed stay in that room overlaps
  // today or a future date, to avoid hiding rooms still needed by bookings.
  if (body.archive === true || body.isActive === false) {
    const today = new Date().toISOString().slice(0, 10);
    const [futureUse] = await db
      .select({ segmentId: stayRoomSegments.id })
      .from(stayRoomSegments)
      .innerJoin(bookings, eq(stayRoomSegments.bookingId, bookings.id))
      .where(
        and(
          eq(stayRoomSegments.roomId, roomId),
          eq(bookings.status, "confirmed"),
          gt(stayRoomSegments.endDate, today)
        )
      )
      .limit(1);

    if (futureUse) {
      return NextResponse.json(
        { error: "This room cannot be archived because it has current or future confirmed bookings." },
        { status: 409 }
      );
    }
    updates.isActive = false;
  }

  const [room] = await db.update(rooms).set(updates).where(eq(rooms.id, roomId)).returning();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  return NextResponse.json(room);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const roomId = Number(id);
  // Soft-delete by default: deactivate rather than hard-delete, so past
  // bookings/segments referencing this room stay intact and reportable.
  const [room] = await db
    .update(rooms)
    .set({ isActive: false })
    .where(eq(rooms.id, roomId))
    .returning();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  return NextResponse.json(room);
}
