import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { beds, bedLocations, floors, rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { eq, isNull } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Every bed, with its current room/floor if it's placed anywhere (see
// bed_locations — a bed with no open location row is unplaced).
export async function GET() {
  const allBeds = await db.select().from(beds);

  const placements = await db
    .select({
      bedId: bedLocations.bedId,
      roomId: rooms.id,
      roomName: rooms.name,
      floorId: floors.id,
      floorName: floors.name,
    })
    .from(bedLocations)
    .innerJoin(rooms, eq(bedLocations.roomId, rooms.id))
    .innerJoin(floors, eq(rooms.floorId, floors.id))
    .where(isNull(bedLocations.endDate));

  const placementByBed = new Map(placements.map((p) => [p.bedId, p]));

  const rows = allBeds.map((bed) => ({
    id: bed.id,
    type: bed.type,
    room: placementByBed.get(bed.id) ?? null,
  }));

  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const type = String(body.type ?? "").trim();
  if (!type) return NextResponse.json({ error: "Bed type is required" }, { status: 400 });

  const [bed] = await db.insert(beds).values({ type }).returning();
  return NextResponse.json(bed, { status: 201 });
}
