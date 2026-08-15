import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";
import { checkHouseCapacity } from "@/lib/house-capacity";
import { findAllocationIssues } from "@/lib/allocation-issues";
import { logChange } from "@/lib/change-log";
import { formatDateUk } from "@/lib/dates";
import { resolveGuestLink } from "@/lib/guests";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [row] = await db.select().from(bookings).where(eq(bookings.id, Number(id)));
  if (!row) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const issues = (await findAllocationIssues()).get(row.id) ?? [];
  return NextResponse.json({ ...row, allocationIssues: issues });
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
  if (body.firstName !== undefined) updates.firstName = String(body.firstName).trim();
  if (body.lastName !== undefined) updates.lastName = String(body.lastName).trim();
  if (body.preferredName !== undefined) updates.preferredName = body.preferredName ? String(body.preferredName).trim() : null;
  if (body.notes !== undefined) updates.notes = body.notes ? String(body.notes).trim() : null;
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
  if (body.sharesBedWithBookingId !== undefined) {
    const sharesId = body.sharesBedWithBookingId ? Number(body.sharesBedWithBookingId) : null;
    if (sharesId === bookingId) {
      return NextResponse.json({ error: "A booking can't share a bed with itself" }, { status: 400 });
    }
    updates.sharesBedWithBookingId = sharesId;
  }
  if (body.dietariesTags !== undefined) {
    updates.dietariesTags = Array.isArray(body.dietariesTags) ? body.dietariesTags : null;
  }
  // Not user-facing — only the grid's own split/merge undo machinery
  // touches this, to put a split lineage back exactly as it was.
  if (body.splitGroupId !== undefined) {
    updates.splitGroupId = body.splitGroupId ? Number(body.splitGroupId) : null;
  }
  if (body.guestCategoryId !== undefined) {
    updates.guestCategoryId = body.guestCategoryId ? Number(body.guestCategoryId) : null;
  }

  const [existing] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!existing) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // guestName stays auto-derived from firstName/lastName (see the schema
  // column's own doc comment) — recomputed here from whichever final
  // values apply, same "unchanged fields keep their current value" pattern
  // used for bedId/dates below, so a PATCH that only touches lastName
  // still produces a correct combined guestName.
  if (updates.firstName !== undefined || updates.lastName !== undefined) {
    const finalFirstName = updates.firstName !== undefined ? updates.firstName : existing.firstName;
    const finalLastName = updates.lastName !== undefined ? updates.lastName : existing.lastName;
    updates.guestName = `${finalFirstName} ${finalLastName}`.trim();
  }

  // Whichever fields this PATCH doesn't touch keep their current value —
  // the capacity check below always needs the FINAL effective bed + date
  // range this booking would occupy, not just what changed (a move that
  // only sends bedId, for instance, must still be checked against its
  // unchanged existing dates).
  const finalBedId = updates.bedId !== undefined ? updates.bedId : existing.bedId;
  const finalArrival = updates.arrivalDate !== undefined ? updates.arrivalDate : existing.arrivalDate;
  const finalDeparture = updates.departureDate !== undefined ? updates.departureDate : existing.departureDate;

  // Same "final effective value" pattern as bed/dates above — a PATCH that
  // only sends dietariesTags (the common case: editing dietary on an
  // already-linked booking) still needs the guest's CURRENT name to write
  // a correct, complete row, not blank/stale fields.
  if (body.guestId !== undefined || body.createGuestProfile === true) {
    const finalPreferredName = updates.preferredName !== undefined ? updates.preferredName : existing.preferredName;
    const finalDietariesTags = updates.dietariesTags !== undefined ? updates.dietariesTags : existing.dietariesTags;
    const finalFirstName = updates.firstName !== undefined ? updates.firstName : existing.firstName;
    const finalLastName = updates.lastName !== undefined ? updates.lastName : existing.lastName;
    updates.guestId = await resolveGuestLink(body, {
      firstName: finalFirstName,
      lastName: finalLastName,
      preferredName: finalPreferredName,
      dietariesTags: finalDietariesTags,
    });
  }

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

  // A split-into-parts stay is still the SAME physical guest throughout —
  // their name, dietary needs and notes don't change from one part to the
  // next, only the dates/bed (each part's own segment) and, deliberately,
  // guestCategoryId do. Propagate whichever of those identity fields this
  // PATCH actually touched to every other part of the same split so they
  // can never drift apart into looking like different people.
  // guestCategoryId is the one exception raised explicitly by staff — see
  // propagateGuestType below — since a stay can plausibly change
  // classification partway through (e.g. a guest becoming a resident) and
  // that's a real, segment-specific fact, not just data hygiene.
  if (row.splitGroupId != null) {
    const siblingUpdates: Partial<typeof bookings.$inferInsert> = {};
    if (updates.firstName !== undefined) siblingUpdates.firstName = updates.firstName;
    if (updates.lastName !== undefined) siblingUpdates.lastName = updates.lastName;
    if (updates.guestName !== undefined) siblingUpdates.guestName = updates.guestName;
    if (updates.preferredName !== undefined) siblingUpdates.preferredName = updates.preferredName;
    if (updates.notes !== undefined) siblingUpdates.notes = updates.notes;
    if (updates.dietariesTags !== undefined) siblingUpdates.dietariesTags = updates.dietariesTags;
    if (updates.guestId !== undefined) siblingUpdates.guestId = updates.guestId;
    if (updates.guestCategoryId !== undefined && body.propagateGuestType === true) siblingUpdates.guestCategoryId = updates.guestCategoryId;

    if (Object.keys(siblingUpdates).length > 0) {
      await db
        .update(bookings)
        .set(siblingUpdates)
        .where(and(eq(bookings.splitGroupId, row.splitGroupId), ne(bookings.id, bookingId)));
    }
  }

  const changedParts: string[] = [];
  if (updates.firstName !== undefined || updates.lastName !== undefined || updates.preferredName !== undefined) changedParts.push("name");
  if (updates.arrivalDate !== undefined || updates.departureDate !== undefined) changedParts.push("dates");
  if (updates.bedId !== undefined) changedParts.push("bed");
  if (updates.guestCategoryId !== undefined) changedParts.push("guest type");
  if (updates.dietariesTags !== undefined) changedParts.push("dietary tags");
  if (updates.notes !== undefined) changedParts.push("notes");
  if (updates.linkedBookingId !== undefined || updates.sharesBedWithBookingId !== undefined) changedParts.push("sharing/linking");
  if (updates.guestId !== undefined) changedParts.push("guest profile link");
  if (changedParts.length > 0) {
    await logChange({
      category: "bookings",
      action: "Updated booking",
      summary: `Updated ${row.guestName}'s booking (${changedParts.join(", ")})`,
    });
  }

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

  await logChange({
    category: "bookings",
    action: "Deleted booking",
    summary: `Deleted ${row.guestName}'s booking, ${formatDateUk(row.arrivalDate)} to ${formatDateUk(row.departureDate)}`,
  });

  return NextResponse.json(row);
}
