import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rooms } from "@/db/schema";
import { sortRooms } from "@/lib/rooms";
import { roomCapacitiesForDates, segmentsInRange } from "@/lib/occupancy";
import { allocateBeds } from "@/lib/bed-grid";
import { formatDateUk } from "@/lib/dates";

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
  const excludeBookingId = Number(req.nextUrl.searchParams.get("excludeBookingId") ?? "0");

  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return NextResponse.json({ options: [] });
  }

  const dates = isoDateList(checkIn, checkOut);
  if (dates.length === 0) {
    return NextResponse.json({ options: [] });
  }

  const activeRooms = sortRooms(
    await db.select().from(rooms).where(eq(rooms.isActive, true))
  );

  let segments = await segmentsInRange(checkIn, checkOut);
  if (excludeBookingId > 0) {
    segments = segments.filter((s) => s.bookingId !== excludeBookingId);
  }

  const capacities = await roomCapacitiesForDates(dates);

  const options: Array<{
    value: string;
    roomId: number;
    bedNumber: number;
    label: string;
    occupied: boolean;
    warning: string | null;
  }> = [];

  for (const room of activeRooms) {
    const capacityByDate = capacities.get(room.id) ?? dates.map(() => 0);
    const minCapacity = capacityByDate.length ? Math.min(...capacityByDate) : 0;
    if (minCapacity < 1) continue;

    const roomSegments = segments.filter((s) => s.roomId === room.id);
    const beds = allocateBeds(dates, capacityByDate, roomSegments);

    for (let bedNumber = 1; bedNumber <= minCapacity; bedNumber++) {
      const row = beds[bedNumber - 1];
      const firstOcc = row?.cells.find((c) => c != null) ?? null;
      const occupied = Boolean(firstOcc);

      let warning: string | null = null;
      let label = `${room.name} - Bed ${bedNumber}`;

      if (occupied && firstOcc) {
        warning = `${firstOcc.segment.leadGuestName} is in this bed until ${formatDateUk(firstOcc.segment.endDate)}.`;
        label = `${label} (booked: ${firstOcc.segment.leadGuestName} until ${formatDateUk(firstOcc.segment.endDate)})`;
      } else {
        label = `${label} (available)`;
      }

      options.push({
        value: `${room.id}:${bedNumber}`,
        roomId: room.id,
        bedNumber,
        label,
        occupied,
        warning,
      });
    }
  }

  options.sort((a, b) => {
    if (a.occupied !== b.occupied) return a.occupied ? 1 : -1;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
  });

  return NextResponse.json({ options });
}