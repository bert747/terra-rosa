import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import { beds, bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { isKnownBedType, listBedTypes } from "@/lib/bed-types";

export const dynamic = "force-dynamic";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bedId = Number(id);
  const body = await req.json();
  const type = String(body.type ?? "").trim();
  if (!(await isKnownBedType(type))) {
    const known = await listBedTypes();
    return NextResponse.json({ error: `Bed type must be one of: ${known.map((t) => t.name).join(", ")}` }, { status: 400 });
  }

  // A bed's type/capacity change is structural (it changes how many guests
  // this bed sleeps) and — like a bed move — has no per-date scoping in the
  // schema, so it takes effect as of today. Block it the same way a move
  // would be blocked: a booking spanning THROUGH today (already mid-stay,
  // not just starting today) would otherwise have its bed's configuration
  // rewritten out from under it. Split the booking first.
  const today = todayISO();
  const [spanning] = await db
    .select({ guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(eq(bookings.bedId, bedId), lt(bookings.arrivalDate, today), gt(bookings.departureDate, today)));
  if (spanning) {
    return NextResponse.json(
      {
        error: `${spanning.guestName}'s booking (${spanning.arrivalDate} to ${spanning.departureDate}) spans through today — split the booking first, then change this bed's type.`,
      },
      { status: 400 }
    );
  }

  const [bed] = await db.update(beds).set({ type }).where(eq(beds.id, bedId)).returning();
  if (!bed) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  await logChange({ category: "layout", action: "Changed bed type", summary: `Changed bed type to ${type}` });
  return NextResponse.json(bed);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bedId = Number(id);

  // Captured before the delete: the FK cascade (bookings.bed_id ON DELETE
  // SET NULL) unassigns these silently, so grab them first to report back.
  const unassignedBookings = await db.select().from(bookings).where(eq(bookings.bedId, bedId));

  const [bed] = await db.delete(beds).where(eq(beds.id, bedId)).returning();
  if (!bed) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  await logChange({ category: "layout", action: "Deleted bed", summary: `Deleted a ${bed.type} bed` });
  return NextResponse.json({ ...bed, unassignedBookings });
}
