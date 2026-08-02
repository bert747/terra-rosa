import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";
import { checkHouseCapacity } from "@/lib/house-capacity";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [row] = await db.select().from(bookings).where(eq(bookings.id, Number(id)));
  if (!row) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bookingId = Number(id);
  const body = await req.json();

  const updates: Partial<typeof bookings.$inferInsert> = {};
  if (body.guestName !== undefined) updates.guestName = String(body.guestName).trim();
  if (body.arrivalDate !== undefined) updates.arrivalDate = body.arrivalDate;
  if (body.departureDate !== undefined) updates.departureDate = body.departureDate;
  if (body.linkedBookingId !== undefined) {
    const linkedId = body.linkedBookingId ? Number(body.linkedBookingId) : null;
    if (linkedId === bookingId) {
      return NextResponse.json({ error: "A booking can't be linked to itself" }, { status: 400 });
    }
    updates.linkedBookingId = linkedId;
  }
  if (body.bedId !== undefined) updates.bedId = body.bedId ? Number(body.bedId) : null;
  if (body.dietariesTags !== undefined) {
    updates.dietariesTags = Array.isArray(body.dietariesTags) ? body.dietariesTags : null;
  }
  if (body.guestType !== undefined && ["resident", "ashrami", "guest"].includes(body.guestType)) {
    updates.guestType = body.guestType;
  }

  const [existing] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!existing) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Whichever fields this PATCH doesn't touch keep their current value —
  // the capacity check below always needs the FINAL effective bed + date
  // range this booking would occupy, not just what changed (a move that
  // only sends bedId, for instance, must still be checked against its
  // unchanged existing dates).
  const finalBedId = updates.bedId !== undefined ? updates.bedId : existing.bedId;
  const finalArrival = updates.arrivalDate !== undefined ? updates.arrivalDate : existing.arrivalDate;
  const finalDeparture = updates.departureDate !== undefined ? updates.departureDate : existing.departureDate;

  if (finalDeparture <= finalArrival) {
    return NextResponse.json({ error: "Departure date must be after arrival date" }, { status: 400 });
  }

  // The single guard covering every way a booking's bed/dates can change —
  // moving it to a new bed, resizing an edge, or a swap's reciprocal PATCH
  // — so none of them can push a bed over capacity and leave grid.ts to
  // silently spawn an extra occupancy row instead of this being rejected.
  const capacityCheck = await checkBedCapacity(finalBedId, finalArrival, finalDeparture, [bookingId]);
  if (!capacityCheck.ok) {
    return NextResponse.json({ error: capacityCheck.error }, { status: 409 });
  }
  if (finalBedId == null) {
    const houseCheck = await checkHouseCapacity(finalArrival, finalDeparture, [bookingId]);
    if (!houseCheck.ok) {
      return NextResponse.json({ error: houseCheck.error }, { status: 409 });
    }
  }

  const [row] = await db.update(bookings).set(updates).where(eq(bookings.id, bookingId)).returning();
  if (!row) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }
  const { id } = await params;
  const [row] = await db.delete(bookings).where(eq(bookings.id, Number(id))).returning();
  if (!row) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json(row);
}
