import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

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
  if (body.groupId !== undefined) updates.groupId = body.groupId ? String(body.groupId).trim() || null : null;
  if (body.bedId !== undefined) updates.bedId = body.bedId ? Number(body.bedId) : null;
  if (body.dietariesTags !== undefined) {
    updates.dietariesTags = Array.isArray(body.dietariesTags) ? body.dietariesTags : null;
  }

  if (
    updates.arrivalDate !== undefined &&
    updates.departureDate !== undefined &&
    updates.departureDate <= updates.arrivalDate
  ) {
    return NextResponse.json({ error: "Departure date must be after arrival date" }, { status: 400 });
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
