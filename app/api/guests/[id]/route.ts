import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { guests } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { syncGuestFieldsToBookings } from "@/lib/guests";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const guestId = Number(id);
  const body = await req.json();

  const updates: Partial<typeof guests.$inferInsert> = {};
  if (body.firstName !== undefined) updates.firstName = String(body.firstName).trim();
  if (body.lastName !== undefined) updates.lastName = String(body.lastName).trim();
  if (body.preferredName !== undefined) updates.preferredName = body.preferredName ? String(body.preferredName).trim() : null;
  if (body.dietariesTags !== undefined) updates.dietariesTags = Array.isArray(body.dietariesTags) ? body.dietariesTags : null;
  if (body.email !== undefined) updates.email = body.email ? String(body.email).trim() : null;
  if (body.phone !== undefined) updates.phone = body.phone ? String(body.phone).trim() : null;

  if (updates.firstName !== undefined && !updates.firstName) {
    return NextResponse.json({ error: "First name is required" }, { status: 400 });
  }
  if (updates.lastName !== undefined && !updates.lastName) {
    return NextResponse.json({ error: "Last name is required" }, { status: 400 });
  }

  const [existing] = await db.select().from(guests).where(eq(guests.id, guestId));
  if (!existing) return NextResponse.json({ error: "Guest not found" }, { status: 404 });

  const [row] = await db.update(guests).set(updates).where(eq(guests.id, guestId)).returning();

  // Same "keep every linked booking's own mirrored fields current" rule as
  // editing dietary from a booking (see resolveGuestLink) — editing the
  // profile directly should behave identically, not be a second, weaker
  // path that leaves bookings stale. Only the name/dietary fields are
  // mirrored (email/phone never are — see syncGuestFieldsToBookings), so
  // this only needs to run when one of THOSE actually changed.
  if (updates.firstName !== undefined || updates.lastName !== undefined || updates.preferredName !== undefined || updates.dietariesTags !== undefined) {
    await syncGuestFieldsToBookings(guestId, {
      firstName: updates.firstName !== undefined ? updates.firstName : existing.firstName,
      lastName: updates.lastName !== undefined ? updates.lastName : existing.lastName,
      preferredName: updates.preferredName !== undefined ? updates.preferredName : existing.preferredName,
      dietariesTags: updates.dietariesTags !== undefined ? updates.dietariesTags : existing.dietariesTags,
    });
  }

  await logChange({ category: "guests", action: "Updated guest profile", summary: `Updated guest profile "${row.firstName} ${row.lastName}"` });

  return NextResponse.json(row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const [row] = await db.delete(guests).where(eq(guests.id, Number(id))).returning();
  if (!row) return NextResponse.json({ error: "Guest not found" }, { status: 404 });

  // bookings.guestId is ON DELETE SET NULL (see the schema) — every booking
  // that was linked to this profile just becomes unlinked, keeping its own
  // last-synced name/dietary exactly as they were. Nothing else to clean up.
  await logChange({ category: "guests", action: "Deleted guest profile", summary: `Deleted guest profile "${row.firstName} ${row.lastName}"` });

  return NextResponse.json(row);
}
