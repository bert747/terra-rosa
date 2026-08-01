import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { beds, bedSoloPeriods, bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { bedCapacity } from "@/lib/bed-types";

export const dynamic = "force-dynamic";

const FAR_FUTURE = "9999-12-31";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Solo periods that haven't fully ended yet — mirrors GET /api/joined-beds.
export async function GET() {
  const today = todayISO();
  const rows = await db
    .select()
    .from(bedSoloPeriods)
    .where(or(isNull(bedSoloPeriods.endDate), gt(bedSoloPeriods.endDate, today)));
  return NextResponse.json(rows);
}

// Sells a native two-person bed (Queen/1.5/Double) as one spot instead of two,
// starting `startDate` (defaults to today). Any existing open period for the
// bed is truncated/deleted the same way bed_locations handles an overlapping
// placement. If two bookings already overlap the bed for dates within this
// solo period (only possible while it was still selling as a couple), all
// but the earliest-starting one are unassigned — that's the one occupant a
// solo spot can actually hold — and returned so the caller can flag them.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bedId = Number(body.bedId);
  const startDate = String(body.startDate ?? todayISO());
  const endDate = body.endDate ? String(body.endDate) : null;

  if (!Number.isInteger(bedId) || bedId <= 0) {
    return NextResponse.json({ error: "A bed is required" }, { status: 400 });
  }
  if (endDate && endDate <= startDate) {
    return NextResponse.json({ error: "End date must be after start date" }, { status: 400 });
  }

  const [bed] = await db.select().from(beds).where(eq(beds.id, bedId));
  if (!bed) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  if (bedCapacity(bed.type) !== 2) {
    return NextResponse.json({ error: "Only a native two-person bed (Queen, 1.5, Double) can go solo" }, { status: 400 });
  }

  const conflicting = await db
    .select()
    .from(bedSoloPeriods)
    .where(and(eq(bedSoloPeriods.bedId, bedId), or(isNull(bedSoloPeriods.endDate), gt(bedSoloPeriods.endDate, startDate))));
  for (const row of conflicting) {
    if (row.startDate >= startDate) {
      await db.delete(bedSoloPeriods).where(eq(bedSoloPeriods.id, row.id));
    } else {
      await db.update(bedSoloPeriods).set({ endDate: startDate }).where(eq(bedSoloPeriods.id, row.id));
    }
  }

  const [period] = await db.insert(bedSoloPeriods).values({ bedId, startDate, endDate }).returning();

  // Greedily pack existing bookings onto a single timeline (slot 0); anything
  // that doesn't fit — i.e. would have needed the now-gone second slot — is
  // unassigned.
  const endBound = endDate ?? FAR_FUTURE;
  const overlapping = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.bedId, bedId), lt(bookings.arrivalDate, endBound), gt(bookings.departureDate, startDate)))
    .orderBy(bookings.arrivalDate, bookings.id);

  let slot0End: string | null = null;
  const displaced: (typeof bookings.$inferSelect)[] = [];
  for (const b of overlapping) {
    if (slot0End === null || b.arrivalDate >= slot0End) {
      slot0End = b.departureDate;
    } else {
      displaced.push(b);
    }
  }

  if (displaced.length > 0) {
    await db
      .update(bookings)
      .set({ bedId: null })
      .where(
        or(...displaced.map((b) => eq(bookings.id, b.id)))
      );
  }

  return NextResponse.json({ ...period, unassignedBookings: displaced }, { status: 201 });
}
