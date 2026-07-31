import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { sortRooms } from "@/lib/rooms";
import { sql } from "drizzle-orm";
import { ensureRoomBedsSeeded } from "@/lib/room-beds";
import { roomBeds } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureRoomBedsSeeded();
  // Natural order (Room 2 before Room 10), not SQL's lexicographic order.
  const all = sortRooms(
    await db.query.rooms.findMany({
      with: { roomBeds: true },
    })
  );
  return NextResponse.json(all);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const defaultBedCount = Number(body.defaultBedCount ?? 1);

  if (!name) return NextResponse.json({ error: "Room name is required" }, { status: 400 });
  if (!Number.isInteger(defaultBedCount) || defaultBedCount < 1) {
    return NextResponse.json({ error: "Default bed count must be a positive integer" }, { status: 400 });
  }

  const [maxOrderRow] = await db
    .select({ maxOrder: sql<number>`COALESCE(MAX(${rooms.displayOrder}), 0)` })
    .from(rooms);
  const displayOrder = Number(maxOrderRow?.maxOrder ?? 0) + 1;

  const [room] = await db
    .insert(rooms)
    .values({
      name,
      locationOrType: body.locationOrType ?? null,
      displayOrder,
      defaultBedCount,
      isActive: body.isActive ?? true,
      notes: body.notes ?? null,
    })
    .returning();

  if (defaultBedCount > 0) {
    await db.insert(roomBeds).values(
      Array.from({ length: defaultBedCount }, (_, index) => ({
        roomId: room.id,
        bedType: "single" as const,
        sortOrder: index + 1,
      }))
    );
  }

  return NextResponse.json(room, { status: 201 });
}
