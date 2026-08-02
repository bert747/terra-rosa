import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { bedLocations, beds, bookings, joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";
import { nextTimelineEventDate } from "@/lib/next-timeline-event";

export const dynamic = "force-dynamic";

// "Shares Bed With" (coupled allocation): this booking already has a Single
// bed picked. Find the next free Single bed in the SAME ROOM ("next bed
// down" — beds sort by ascending id within a room, see sortRoomUnits in
// src/lib/grid.ts), assign it to the partner booking, join the two beds
// into a "double" until the next scheduled timeline event for either bed,
// and symmetrically link both bookings via sharesBedWithBookingId.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bookingId = Number(id);
  const body = await req.json();
  const partnerBookingId = Number(body.partnerBookingId);
  if (!Number.isInteger(partnerBookingId) || partnerBookingId === bookingId) {
    return NextResponse.json({ error: "A different partner booking is required" }, { status: 400 });
  }

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  const [partner] = await db.select().from(bookings).where(eq(bookings.id, partnerBookingId));
  if (!booking || !partner) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (booking.bedId == null) return NextResponse.json({ error: "This booking needs a bed picked first" }, { status: 400 });

  const [bed] = await db.select().from(beds).where(eq(beds.id, booking.bedId));
  if (!bed || bed.type.toLowerCase() !== "single") {
    return NextResponse.json({ error: "Shares Bed With requires a Single bed" }, { status: 400 });
  }

  const [placement] = await db
    .select({ roomId: bedLocations.roomId })
    .from(bedLocations)
    .where(and(eq(bedLocations.bedId, booking.bedId), isNull(bedLocations.endDate)));
  if (!placement) return NextResponse.json({ error: "This bed isn't placed in a room" }, { status: 400 });

  const roomBeds = await db
    .select({ bedId: bedLocations.bedId, type: beds.type })
    .from(bedLocations)
    .innerJoin(beds, eq(beds.id, bedLocations.bedId))
    .where(and(eq(bedLocations.roomId, placement.roomId), isNull(bedLocations.endDate)));

  const candidateIds = roomBeds
    .filter((b) => b.bedId !== booking.bedId && b.type.toLowerCase() === "single")
    .map((b) => b.bedId)
    .sort((a, b2) => {
      // Prefer the next bed DOWN (nearest higher id) before falling back to
      // the nearest lower one.
      const aDown = a > booking.bedId!;
      const bDown = b2 > booking.bedId!;
      if (aDown !== bDown) return aDown ? -1 : 1;
      return Math.abs(a - booking.bedId!) - Math.abs(b2 - booking.bedId!);
    });

  const startDate = booking.arrivalDate < partner.arrivalDate ? booking.arrivalDate : partner.arrivalDate;

  let chosenBedId: number | null = null;
  for (const candidateId of candidateIds) {
    const check = await checkBedCapacity(candidateId, partner.arrivalDate, partner.departureDate, [partnerBookingId]);
    if (check.ok) {
      chosenBedId = candidateId;
      break;
    }
  }
  if (chosenBedId == null) {
    return NextResponse.json({ error: "No free Single bed available in the same room to pair with" }, { status: 400 });
  }

  const endDate = await nextTimelineEventDate([booking.bedId, chosenBedId], startDate);

  const result = await db.transaction(async (tx) => {
    await tx.update(bookings).set({ bedId: chosenBedId, sharesBedWithBookingId: bookingId }).where(eq(bookings.id, partnerBookingId));
    await tx.update(bookings).set({ sharesBedWithBookingId: partnerBookingId }).where(eq(bookings.id, bookingId));
    const [join] = await tx
      .insert(joinedBeds)
      .values({ bed1Id: booking.bedId!, bed2Id: chosenBedId!, startDate, endDate, mode: "double" })
      .returning();
    return { join, partnerBedId: chosenBedId };
  });

  return NextResponse.json(result, { status: 201 });
}
