import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { bedLocations, rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();

  const updates: Partial<typeof rooms.$inferInsert> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.floorId !== undefined) updates.floorId = Number(body.floorId);
  if (body.categoryId !== undefined) updates.categoryId = body.categoryId ? Number(body.categoryId) : null;
  if (body.excludeFromSuggestions !== undefined) updates.excludeFromSuggestions = Boolean(body.excludeFromSuggestions);

  const [room] = await db.update(rooms).set(updates).where(eq(rooms.id, Number(id))).returning();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  if (updates.categoryId !== undefined || updates.excludeFromSuggestions !== undefined) {
    await logChange({ category: "layout", action: "Updated room suggestions setting", summary: `Updated "${room.name}"'s move-suggestion settings` });
  } else {
    await logChange({ category: "layout", action: "Updated room", summary: `Updated room "${room.name}"` });
  }

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

  // A cascading delete here used to silently unplace every bed still in the
  // room. Deleting a room now requires it to be empty first (move its beds
  // elsewhere, or remove them) — a bed_locations row that's still open-ended
  // or extends past today means a bed is genuinely "in" this room right now
  // or will be; a row whose endDate is already in the past is just history
  // and doesn't count.
  const today = new Date().toISOString().slice(0, 10);
  const [stillHasBed] = await db
    .select({ id: bedLocations.id })
    .from(bedLocations)
    .where(and(eq(bedLocations.roomId, roomId), or(isNull(bedLocations.endDate), gt(bedLocations.endDate, today))))
    .limit(1);
  if (stillHasBed) {
    return NextResponse.json({ error: "This room still has beds in it — move or remove them first." }, { status: 400 });
  }

  const [room] = await db.delete(rooms).where(eq(rooms.id, roomId)).returning();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  await logChange({ category: "layout", action: "Deleted room", summary: `Deleted room "${room.name}"` });
  return NextResponse.json(room);
}
