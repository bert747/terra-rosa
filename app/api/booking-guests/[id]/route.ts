import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookingGuests } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { isPlausibleEmail, normaliseOptional } from "@/lib/guests";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const updates: Partial<typeof bookingGuests.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Person name is required" }, { status: 400 });
    if (name.length > 200) return NextResponse.json({ error: "Person name is too long" }, { status: 400 });
    updates.name = name;
  }
  if (body.dietaryRequirements !== undefined) {
    updates.dietaryRequirements = normaliseOptional(body.dietaryRequirements);
  }
  if (body.phone !== undefined) updates.phone = normaliseOptional(body.phone);
  if (body.email !== undefined) {
    const email = normaliseOptional(body.email);
    if (email && !isPlausibleEmail(email)) {
      return NextResponse.json({ error: "Email doesn't look valid" }, { status: 400 });
    }
    updates.email = email;
  }
  if (body.preferredBed !== undefined) {
    const preferredBed = Number(body.preferredBed);
    updates.preferredBed = Number.isInteger(preferredBed) && preferredBed > 0 ? preferredBed : null;
  }

  const [row] = await db
    .update(bookingGuests)
    .set(updates)
    .where(eq(bookingGuests.id, Number(id)))
    .returning();
  if (!row) return NextResponse.json({ error: "Person not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }
  const { id } = await params;
  const [row] = await db
    .delete(bookingGuests)
    .where(eq(bookingGuests.id, Number(id)))
    .returning();
  if (!row) return NextResponse.json({ error: "Person not found" }, { status: 404 });
  return NextResponse.json(row);
}
