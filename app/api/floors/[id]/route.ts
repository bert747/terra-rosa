import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { floors, rooms } from "@/db/schema";
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
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Floor name is required" }, { status: 400 });

  const [floor] = await db.update(floors).set({ name }).where(eq(floors.id, Number(id))).returning();
  if (!floor) return NextResponse.json({ error: "Floor not found" }, { status: 404 });
  await logChange({ category: "layout", action: "Renamed floor", summary: `Renamed floor to "${name}"` });
  return NextResponse.json(floor);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const floorId = Number(id);

  // A cascading delete here used to silently take every room on the floor
  // (and their beds' placements) down with it — "drastic" for what's meant
  // to be a structural edit. Deleting a floor now requires emptying it
  // first (move its rooms elsewhere, or delete them), same as a room
  // requires emptying its beds first — see the matching check in
  // rooms/[id]/route.ts.
  const [stillHasRoom] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.floorId, floorId)).limit(1);
  if (stillHasRoom) {
    return NextResponse.json({ error: "This floor still has rooms on it — move or delete them first." }, { status: 400 });
  }

  const [floor] = await db.delete(floors).where(eq(floors.id, floorId)).returning();
  if (!floor) return NextResponse.json({ error: "Floor not found" }, { status: 404 });
  await logChange({ category: "layout", action: "Deleted floor", summary: `Deleted floor "${floor.name}"` });
  return NextResponse.json(floor);
}
