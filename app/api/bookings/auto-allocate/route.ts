import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bedLocations, bookings, rooms } from "@/db/schema";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { requireEditor } from "@/lib/auth";
import { checkBedCapacity } from "@/lib/booking-guard";
import { findAvailableBeds } from "@/lib/available-beds";
import { addDays } from "@/lib/occupancy";
import { pairWithAnchor } from "@/lib/share-bed";
import { findGroupMoveProposal, resolveExistingGroup, type GroupMoveProposal } from "@/lib/group-move";

export const dynamic = "force-dynamic";

async function roomIdForBed(bedId: number, onDate: string): Promise<number | null> {
  const locationRows = await db.select().from(bedLocations).where(eq(bedLocations.bedId, bedId));
  const active = locationRows.find((r) => r.startDate <= onDate && (r.endDate == null || r.endDate > onDate));
  return active?.roomId ?? null;
}

// Manual, reviewable bulk-assignment — NOT automatic on booking creation.
// Fills in a real bed for every currently-unassigned booking arriving
// within the next `withinDays` days, one at a time in arrival order, so
// staff can glance at the result and fix up anything that landed oddly
// (see the "Needs a bed" panel on the grid, which triggers this and shows
// what changed). Bookings without a fit are left alone and reported back,
// not silently skipped.
//
// A candidate is handled one of three ways, in order:
//   1. "Shares bed with" someone already placed — the ONLY case allowed to
//      touch a Single-pair join or a native multi-capacity bed at all.
//      Tries to seat them right next to their partner (same logic as the
//      manual "Shares Bed With" flow); if that room has no room for both,
//      proposes moving the PAIR to a fresh room together instead of ever
//      dropping either of them into an unrelated occupied bed.
//   2. "Sleeps near" a placed booking (a same-room hint only, no pairing) —
//      tries a genuinely solo, unshared bed in that room; if none, proposes
//      moving the "sleeps near" GROUP (the target + their own bed-partner,
//      if any) to a room that fits everyone, same confirm-first pattern.
//   3. No relationship at all — a plain solo Single anywhere, never a
//      multi-capacity or already-occupied bed.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const withinDays = Number.isInteger(body.withinDays) && body.withinDays > 0 ? body.withinDays : 7;
  // Set by the grid's per-booking "Allocate" action (see the Actions menu)
  // to run this same logic for just the one booking, instead of the whole
  // window's worth of unassigned candidates.
  const onlyBookingId = Number.isInteger(body.bookingId) ? Number(body.bookingId) : null;

  const today = new Date().toISOString().slice(0, 10);
  const windowEnd = addDays(today, withinDays);

  const candidates = await db
    .select()
    .from(bookings)
    .where(
      onlyBookingId != null
        ? and(isNull(bookings.bedId), eq(bookings.id, onlyBookingId))
        : and(isNull(bookings.bedId), gte(bookings.arrivalDate, today), lt(bookings.arrivalDate, windowEnd))
    )
    .orderBy(bookings.arrivalDate);

  const assigned: { id: number; guestName: string; bedId: number; roomName: string }[] = [];
  const skipped: { id: number; guestName: string; reason: string }[] = [];
  const proposals: GroupMoveProposal[] = [];

  for (const booking of candidates) {
    if (booking.sharesBedWithBookingId != null) {
      const [anchor] = await db.select().from(bookings).where(eq(bookings.id, booking.sharesBedWithBookingId));
      if (!anchor || anchor.bedId == null) {
        skipped.push({ id: booking.id, guestName: booking.guestName, reason: "Their bed-partner doesn't have a bed yet either — assign that booking first." });
        continue;
      }

      // requireBed defaults to true (not passed here) — pairResult.bedId is
      // only ever null when the caller opts out of that, so this is just
      // satisfying the type, not a real runtime path for this call site.
      const pairResult = await pairWithAnchor(anchor.id, booking.id);
      if (pairResult.ok && pairResult.bedId != null) {
        const [placement] = await db
          .select({ roomName: rooms.name })
          .from(bedLocations)
          .innerJoin(rooms, eq(bedLocations.roomId, rooms.id))
          .where(eq(bedLocations.bedId, pairResult.bedId));
        assigned.push({ id: booking.id, guestName: booking.guestName, bedId: pairResult.bedId, roomName: placement?.roomName ?? "" });
        continue;
      }

      const anchorRoomId = await roomIdForBed(anchor.bedId, booking.arrivalDate);
      const proposal = anchorRoomId != null ? await findGroupMoveProposal(booking, [anchor], anchorRoomId) : null;
      if (proposal) {
        proposals.push(proposal);
        skipped.push({
          id: booking.id,
          guestName: booking.guestName,
          reason: `No free bed next to ${anchor.guestName} — proposed moving ${proposal.guestNames.join(", ")} to ${proposal.toRoomName} (needs confirmation).`,
        });
      } else {
        skipped.push({ id: booking.id, guestName: booking.guestName, reason: `No room fits ${booking.guestName} and ${anchor.guestName} together — move manually.` });
      }
      continue;
    }

    // "Sleeps near" preference: try the linked booking's room first — a
    // solo, unshared bed only, never a multi-capacity/occupied one (that's
    // reserved for an explicit "shares bed with" pairing, handled above).
    let nearRoomId: number | null = null;
    let linkedBooking: typeof bookings.$inferSelect | undefined;
    if (booking.linkedBookingId != null) {
      [linkedBooking] = await db.select().from(bookings).where(eq(bookings.id, booking.linkedBookingId));
      if (linkedBooking?.bedId != null) nearRoomId = await roomIdForBed(linkedBooking.bedId, booking.arrivalDate);
    }

    const candidateBeds = await findAvailableBeds({
      arrivalDate: booking.arrivalDate,
      departureDate: booking.departureDate,
      excludeBookingId: booking.id,
      nearRoomId: nearRoomId ?? undefined,
      onlySingleUnshared: true,
    });

    if (candidateBeds.length === 0) {
      // The preferred room has no solo bed free — never silently scatter
      // this booking to an unrelated bed elsewhere, or drop it into a
      // multi-capacity/occupied bed just because one has spare capacity.
      // If it's tied to a group (the "sleeps near" target, possibly with
      // their own bed-partner), try to find ONE other room that fits the
      // whole group and surface it as a proposal for staff to
      // confirm/decline instead of applying it automatically.
      if (nearRoomId != null) {
        const group = await resolveExistingGroup(booking.linkedBookingId!, linkedBooking);
        if (group.length > 0) {
          const proposal = await findGroupMoveProposal(booking, group, nearRoomId);
          if (proposal) {
            proposals.push(proposal);
            skipped.push({
              id: booking.id,
              guestName: booking.guestName,
              reason: `${proposal.fromRoomName} has no solo bed free — proposed moving ${proposal.guestNames.join(", ")} to ${proposal.toRoomName} (needs confirmation).`,
            });
          } else {
            skipped.push({
              id: booking.id,
              guestName: booking.guestName,
              reason: `The room has no solo bed free and no other room fits the whole group (${group.map((g) => g.guestName).join(", ")}) together — move manually.`,
            });
          }
          continue;
        }
      }
      skipped.push({ id: booking.id, guestName: booking.guestName, reason: "No free bed fits these dates." });
      continue;
    }

    const chosen = candidateBeds.reduce((lowest, b) => (b.id < lowest.id ? b : lowest));
    const check = await checkBedCapacity(chosen.id, booking.arrivalDate, booking.departureDate, [booking.id]);
    if (!check.ok) {
      skipped.push({ id: booking.id, guestName: booking.guestName, reason: check.error ?? "Bed no longer available." });
      continue;
    }

    await db.update(bookings).set({ bedId: chosen.id }).where(eq(bookings.id, booking.id));
    assigned.push({ id: booking.id, guestName: booking.guestName, bedId: chosen.id, roomName: chosen.roomName });
  }

  return NextResponse.json({ assigned, skipped, proposals });
}
