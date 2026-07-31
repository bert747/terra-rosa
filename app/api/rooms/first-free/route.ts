import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { occupancyByRoomForCapacity, roomCapacitiesForDates } from "@/lib/occupancy";
import { sortRooms } from "@/lib/rooms";

export const dynamic = "force-dynamic";

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoDateList(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

export async function GET(req: NextRequest) {
  const checkIn = req.nextUrl.searchParams.get("checkIn") ?? "";
  const checkOut = req.nextUrl.searchParams.get("checkOut") ?? "";
  const guestCount = Number(req.nextUrl.searchParams.get("guestCount") ?? "1");

  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return NextResponse.json({ roomId: null, reason: "valid-date-range-required" });
  }
  if (!Number.isInteger(guestCount) || guestCount < 1) {
    return NextResponse.json({ error: "guestCount must be a positive integer" }, { status: 400 });
  }

  const dates = isoDateList(checkIn, checkOut);
  if (dates.length === 0) {
    return NextResponse.json({ roomId: null, reason: "no-nights" });
  }

  const activeRooms = sortRooms(
    await db.select().from(rooms).where(eq(rooms.isActive, true))
  );

  const [capacities, occupancyMaps] = await Promise.all([
    roomCapacitiesForDates(dates),
    Promise.all(dates.map((d) => occupancyByRoomForCapacity(d))),
  ]);

  for (const room of activeRooms) {
    const perDateCapacity = capacities.get(room.id) ?? dates.map(() => 0);
    let fitsWholeStay = true;
    for (let i = 0; i < dates.length; i++) {
      const occupied = occupancyMaps[i].get(room.id) ?? 0;
      if (occupied + guestCount > (perDateCapacity[i] ?? 0)) {
        fitsWholeStay = false;
        break;
      }
    }
    if (fitsWholeStay) {
      return NextResponse.json({
        roomId: room.id,
        roomName: room.name,
        locationOrType: room.locationOrType,
      });
    }
  }

  return NextResponse.json({ roomId: null, reason: "no-room-fits-entire-stay" });
}