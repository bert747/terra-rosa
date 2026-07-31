import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { roomBeds, rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { BED_TYPE_LABELS, ensureRoomBedsSeeded, nextRoomBedSortOrder, syncRoomBedCount } from "@/lib/room-beds";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureRoomBedsSeeded();
  const roomId = Number(req.nextUrl.searchParams.get("roomId") ?? "0");
  if (roomId > 0) {
    const rows = await db.query.roomBeds.findMany({ where: eq(roomBeds.roomId, roomId) });
    return NextResponse.json(rows);
  }
  const rows = await db.select().from(roomBeds);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  await ensureRoomBedsSeeded();

  const body = await req.json();
  const roomId = Number(body.roomId ?? 0);
  const bedType = String(body.bedType ?? "single") as keyof typeof BED_TYPE_LABELS;

  if (!roomId) return NextResponse.json({ error: "roomId is required" }, { status: 400 });
  if (!(bedType in BED_TYPE_LABELS)) {
    return NextResponse.json({ error: "Invalid bed type" }, { status: 400 });
  }

  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room || !room.isActive) return NextResponse.json({ error: "Room not found" }, { status: 404 });

  let created;
  if (bedType === "joined_single_pair") {
    const singleBeds = await db.query.roomBeds.findMany({ where: eq(roomBeds.roomId, roomId) });
    const singles = singleBeds
      .filter((bed) => bed.bedType === "single")
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    if (singles.length < 2) {
      return NextResponse.json({ error: "Need two single beds in the room to create a joined pair." }, { status: 409 });
    }
    const bedsToRemove = singles.slice(-2);
    await db.delete(roomBeds).where(eq(roomBeds.id, bedsToRemove[0].id));
    await db.delete(roomBeds).where(eq(roomBeds.id, bedsToRemove[1].id));
    const sortOrder = await nextRoomBedSortOrder(roomId);
    [created] = await db.insert(roomBeds).values({ roomId, bedType, sortOrder }).returning();
  } else {
    const sortOrder = await nextRoomBedSortOrder(roomId);
    [created] = await db.insert(roomBeds).values({ roomId, bedType, sortOrder }).returning();
  }
  await syncRoomBedCount(roomId);
  return NextResponse.json(created, { status: 201 });
}
