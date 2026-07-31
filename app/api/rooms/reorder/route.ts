import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = (await req.json()) as { roomIds?: unknown };
  if (!Array.isArray(body.roomIds) || body.roomIds.length === 0) {
    return NextResponse.json({ error: "roomIds array is required" }, { status: 400 });
  }

  const roomIds = body.roomIds.map((raw) => Number(raw));
  if (roomIds.some((id) => !Number.isInteger(id) || id < 1)) {
    return NextResponse.json({ error: "roomIds must be positive integers" }, { status: 400 });
  }
  if (new Set(roomIds).size !== roomIds.length) {
    return NextResponse.json({ error: "roomIds cannot contain duplicates" }, { status: 400 });
  }

  const existing = await db.select({ id: rooms.id }).from(rooms);
  const existingIds = new Set(existing.map((r) => r.id));
  for (const id of roomIds) {
    if (!existingIds.has(id)) {
      return NextResponse.json({ error: `Room ${id} does not exist` }, { status: 400 });
    }
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < roomIds.length; i++) {
      await tx
        .update(rooms)
        .set({ displayOrder: i + 1 })
        .where(eq(rooms.id, roomIds[i]));
    }
  });

  return NextResponse.json({ ok: true });
}
