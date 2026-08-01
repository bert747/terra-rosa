import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

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

  const [room] = await db.update(rooms).set(updates).where(eq(rooms.id, Number(id))).returning();
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
  // Cascades to bed_locations rows for this room; the beds themselves survive,
  // just left without a current location.
  const [room] = await db.delete(rooms).where(eq(rooms.id, Number(id))).returning();
  if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });
  return NextResponse.json(room);
}
