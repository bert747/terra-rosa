import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { isPlausibleEmail, normaliseOptional } from "@/lib/guests";

export const dynamic = "force-dynamic";

const VALID_BOOKING_STATUS = ["draft", "confirmed", "cancelled"] as const;
const VALID_BOOKING_TYPES = ["guest", "resident", "guardian", "worker"] as const;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await db.query.bookings.findFirst({
    where: eq(bookings.id, Number(id)),
    with: { segments: true, guests: true, operationalNotes: true },
  });
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

  const updates: Partial<typeof bookings.$inferInsert> = { updatedAt: new Date() };
  if (body.leadGuestName !== undefined) updates.leadGuestName = String(body.leadGuestName).trim();
  if (body.contactPhone !== undefined) updates.contactPhone = normaliseOptional(body.contactPhone);
  if (body.contactEmail !== undefined) {
    const email = normaliseOptional(body.contactEmail);
    if (email && !isPlausibleEmail(email)) {
      return NextResponse.json({ error: "Contact email doesn't look valid" }, { status: 400 });
    }
    updates.contactEmail = email;
  }
  if (body.guestCount !== undefined) updates.guestCount = Number(body.guestCount);
  if (body.checkInDate !== undefined) updates.checkInDate = body.checkInDate;
  if (body.checkOutDate !== undefined) updates.checkOutDate = body.checkOutDate;
  if (body.bookingType !== undefined) {
    if (!VALID_BOOKING_TYPES.includes(body.bookingType)) {
      return NextResponse.json({ error: "Invalid booking type" }, { status: 400 });
    }
    updates.bookingType = body.bookingType;
  }
  // Counts are always on for this deployment.
  updates.countsTowardCapacity = true;
  updates.countsTowardMeals = true;
  if (body.status !== undefined) {
    if (!VALID_BOOKING_STATUS.includes(body.status)) {
      return NextResponse.json({ error: "Invalid booking status" }, { status: 400 });
    }
    updates.status = body.status;
  }
  if (body.notes !== undefined) updates.notes = body.notes;

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
  // Cancel rather than hard-delete, preserving history for reporting.
  const [row] = await db
    .update(bookings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(bookings.id, Number(id)))
    .returning();
  if (!row) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  return NextResponse.json(row);
}
