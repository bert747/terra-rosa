import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { roomBeds, rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { BED_TYPE_LABELS, ensureRoomBedsSeeded, nextRoomBedSortOrder, syncRoomBedCount } from "@/lib/room-beds";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  await ensureRoomBedsSeeded();

  const { id } = await params;
  const bedId = Number(id);
  const body = await req.json();
  const existing = await db.query.roomBeds.findFirst({ where: eq(roomBeds.id, bedId) });
  if (!existing) return NextResponse.json({ error: "Bed not found" }, { status: 404 });

  const updates: Partial<typeof roomBeds.$inferInsert> = {};
  if (body.roomId !== undefined) {
    const roomId = Number(body.roomId);
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room || !room.isActive) return NextResponse.json({ error: "Target room not found" }, { status: 404 });
    updates.roomId = roomId;
    updates.sortOrder = await nextRoomBedSortOrder(roomId);
  }
  if (body.bedType !== undefined) {
    const bedType = String(body.bedType) as keyof typeof BED_TYPE_LABELS;
    if (!(bedType in BED_TYPE_LABELS)) return NextResponse.json({ error: "Invalid bed type" }, { status: 400 });
    updates.bedType = bedType;
  }

  const [updated] = await db.update(roomBeds).set(updates).where(eq(roomBeds.id, bedId)).returning();
  if (!updated) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  await syncRoomBedCount(existing.roomId);
  await syncRoomBedCount(updated.roomId);
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  await ensureRoomBedsSeeded();

  const { id } = await params;
  const bedId = Number(id);
  const [deleted] = await db.delete(roomBeds).where(eq(roomBeds.id, bedId)).returning();
  if (!deleted) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  if (deleted.bedType === "joined_single_pair") {
    const sortOrder = await nextRoomBedSortOrder(deleted.roomId);
    await db.insert(roomBeds).values([
      { roomId: deleted.roomId, bedType: "single", sortOrder },
      { roomId: deleted.roomId, bedType: "single", sortOrder: sortOrder + 1 },
    ]);
  }
  await syncRoomBedCount(deleted.roomId);
  return NextResponse.json(deleted);
}
