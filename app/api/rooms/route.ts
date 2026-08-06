import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(rooms);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const floorId = Number(body.floorId);

  if (!name) return NextResponse.json({ error: "Room name is required" }, { status: 400 });
  if (!Number.isInteger(floorId) || floorId <= 0) {
    return NextResponse.json({ error: "A floor is required" }, { status: 400 });
  }

  const [room] = await db.insert(rooms).values({ name, floorId }).returning();
  await logChange({ category: "layout", action: "Created room", summary: `Created room "${name}"` });
  return NextResponse.json(room, { status: 201 });
}
