import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { roomBeds, rooms } from "@/db/schema";
import { ensureRoomBedsSeeded } from "@/lib/room-beds";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureRoomBedsSeeded();

  const activeRoomIds = new Set(
    (await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.isActive, true))).map((row) => row.id)
  );
  const beds = await db.select().from(roomBeds);

  let singleBeds = 0;
  let queenBeds = 0;
  let joinedSinglePairBeds = 0;

  for (const bed of beds) {
    if (!activeRoomIds.has(bed.roomId)) continue;
    if (bed.bedType === "queen") queenBeds += 1;
    else if (bed.bedType === "joined_single_pair") joinedSinglePairBeds += 1;
    else singleBeds += 1;
  }

  return NextResponse.json({
    singleBeds,
    queenBeds,
    joinedSinglePairBeds,
  });
}

export async function POST(req: NextRequest) {
  return NextResponse.json({ error: "Use /api/room-beds to add, move, or remove specific beds." }, { status: 405 });
}
