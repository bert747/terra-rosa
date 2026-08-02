import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";
import { checkHouseCapacity } from "@/lib/house-capacity";
import { nextTimelineEventDate } from "@/lib/next-timeline-event";
import { desc } from "drizzle-orm";

const GUEST_TYPES = ["resident", "ashrami", "guest"] as const;

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(bookings).orderBy(desc(bookings.arrivalDate));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const guestName = String(body.guestName ?? "").trim();
  const arrivalDate = String(body.arrivalDate ?? "");
  const departureDate = String(body.departureDate ?? "");
  const linkedBookingId = body.linkedBookingId ? Number(body.linkedBookingId) : null;
  const bedId = body.bedId ? Number(body.bedId) : null;
  const dietariesTags = Array.isArray(body.dietariesTags) ? body.dietariesTags : null;
  const guestType = GUEST_TYPES.includes(body.guestType) ? body.guestType : "guest";
  // Auto-Join Fallback (see /api/beds/available's fallbackPairs): the client
  // picked a plain free Single because no double was available, and wants
  // it auto-joined with another free Single in the same room.
  const partnerBedId = body.partnerBedId ? Number(body.partnerBedId) : null;

  if (!guestName) return NextResponse.json({ error: "Guest name is required" }, { status: 400 });
  if (!arrivalDate) return NextResponse.json({ error: "Arrival date is required" }, { status: 400 });
  if (!departureDate) return NextResponse.json({ error: "Departure date is required" }, { status: 400 });
  if (departureDate <= arrivalDate) {
    return NextResponse.json({ error: "Departure date must be after arrival date" }, { status: 400 });
  }

  const capacityCheck = await checkBedCapacity(bedId, arrivalDate, departureDate);
  if (!capacityCheck.ok) {
    return NextResponse.json({ error: capacityCheck.error }, { status: 409 });
  }
  if (bedId == null) {
    const houseCheck = await checkHouseCapacity(arrivalDate, departureDate);
    if (!houseCheck.ok) {
      return NextResponse.json({ error: houseCheck.error }, { status: 409 });
    }
  }
  if (partnerBedId != null) {
    const partnerCheck = await checkBedCapacity(partnerBedId, arrivalDate, departureDate);
    if (!partnerCheck.ok) {
      return NextResponse.json({ error: partnerCheck.error }, { status: 409 });
    }
  }

  const booking = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(bookings)
      .values({ guestName, arrivalDate, departureDate, linkedBookingId, bedId, dietariesTags, guestType })
      .returning();

    if (bedId != null && partnerBedId != null) {
      const endDate = await nextTimelineEventDate([bedId, partnerBedId], arrivalDate);
      await tx.insert(joinedBeds).values({ bed1Id: bedId, bed2Id: partnerBedId, startDate: arrivalDate, endDate, mode: "double" });
    }

    return row;
  });

  return NextResponse.json(booking, { status: 201 });
}
