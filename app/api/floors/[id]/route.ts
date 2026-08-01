import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { floors } from "@/db/schema";
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
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Floor name is required" }, { status: 400 });

  const [floor] = await db.update(floors).set({ name }).where(eq(floors.id, Number(id))).returning();
  if (!floor) return NextResponse.json({ error: "Floor not found" }, { status: 404 });
  return NextResponse.json(floor);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  // Cascades to rooms on this floor, then to bed_locations for beds that were
  // in those rooms (beds themselves survive — see the beds table comment).
  const [floor] = await db.delete(floors).where(eq(floors.id, Number(id))).returning();
  if (!floor) return NextResponse.json({ error: "Floor not found" }, { status: 404 });
  return NextResponse.json(floor);
}
