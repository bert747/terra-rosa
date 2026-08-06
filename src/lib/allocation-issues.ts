import { db } from "@/db";
import { bedLocations, bookings, joinedBeds } from "@/db/schema";
import { eq } from "drizzle-orm";
import { findAvailableBeds } from "@/lib/available-beds";
import type { ISODate } from "@/lib/occupancy";

export interface AllocationIssue {
  otherBookingId: number;
  otherGuestName: string;
  /** "room" = a "Sleeps near" (linkedBookingId) mismatch; "bed" = a "Shares bed with" (sharesBedWithBookingId) mismatch. */
  kind: "room" | "bed";
}

type BookingRow = typeof bookings.$inferSelect;

function overlaps(a: BookingRow, b: BookingRow): boolean {
  return a.arrivalDate < b.departureDate && b.arrivalDate < a.departureDate;
}

/**
 * Flags bookings whose OWN declared relationship — "Sleeps near"
 * (linkedBookingId, a same-room hint) or "Shares bed with"
 * (sharesBedWithBookingId, a same-bed pairing) — isn't actually being met.
 * Deliberately relationship-driven, not proximity-driven: a booking that's
 * satisfying its own pairing is never flagged just because some OTHER,
 * unrelated booking happens to be nearby (in the same room, or a later
 * occupant of the same bed on different dates) — that was the bug in the
 * first pass at this (see git history), which flagged a legitimately
 * paired booking for a stranger's unrelated mismatch three doors down.
 *
 * When only one side of a relationship has a bed so far, that's not
 * automatically a problem — it's just pending. It only becomes a flagged
 * issue once the room the placed side is already in has run out of spare
 * capacity to seat the other side too, i.e. the current placement has
 * already made the relationship impossible to satisfy without a manual
 * move. Both bookings in an unmet relationship are flagged, not just one,
 * so the issue is visible from whichever pill staff happen to look at.
 */
export async function findAllocationIssues(): Promise<Map<number, AllocationIssue[]>> {
  const allBookings = await db.select().from(bookings);
  const byId = new Map(allBookings.map((b) => [b.id, b]));
  const activeJoins = await db.select().from(joinedBeds).where(eq(joinedBeds.mode, "double"));
  const locationRows = await db.select().from(bedLocations);

  function roomForBed(bedId: number, onDate: ISODate): number | null {
    const seg = locationRows.find((r) => r.bedId === bedId && r.startDate <= onDate && (r.endDate == null || r.endDate > onDate));
    return seg?.roomId ?? null;
  }

  function sameBedOrJoined(a: BookingRow, b: BookingRow): boolean {
    if (a.bedId == null || b.bedId == null) return false;
    if (a.bedId === b.bedId) return true;
    const overlapStart = a.arrivalDate > b.arrivalDate ? a.arrivalDate : b.arrivalDate;
    const overlapEnd = a.departureDate < b.departureDate ? a.departureDate : b.departureDate;
    return activeJoins.some(
      (j) =>
        ((j.bed1Id === a.bedId && j.bed2Id === b.bedId) || (j.bed2Id === a.bedId && j.bed1Id === b.bedId)) &&
        j.startDate <= overlapStart &&
        (j.endDate == null || j.endDate >= overlapEnd)
    );
  }

  // Does the room a placed booking is already in still have ANY spare bed
  // (of any kind) for the other side's own dates? If so, the relationship
  // is still resolvable without moving anyone — not an issue yet.
  async function roomStillHasRoom(roomId: number, unplaced: BookingRow): Promise<boolean> {
    const beds = await findAvailableBeds({
      arrivalDate: unplaced.arrivalDate,
      departureDate: unplaced.departureDate,
      excludeBookingId: unplaced.id,
      nearRoomId: roomId,
    });
    return beds.length > 0;
  }

  const issues = new Map<number, AllocationIssue[]>();
  function addIssue(bookingId: number, otherBookingId: number, otherGuestName: string, kind: "room" | "bed") {
    const list = issues.get(bookingId) ?? [];
    list.push({ otherBookingId, otherGuestName, kind });
    issues.set(bookingId, list);
  }

  async function evaluate(s: BookingRow, t: BookingRow, kind: "room" | "bed") {
    if (s.bedId == null && t.bedId == null) return; // neither placed — nothing to check yet

    if (s.bedId != null && t.bedId != null) {
      const met =
        kind === "bed"
          ? sameBedOrJoined(s, t)
          : (() => {
              const sRoom = roomForBed(s.bedId!, s.arrivalDate);
              const tRoom = roomForBed(t.bedId!, t.arrivalDate);
              return sRoom != null && tRoom != null && sRoom === tRoom;
            })();
      if (!met && overlaps(s, t)) {
        addIssue(s.id, t.id, t.guestName, kind);
        addIssue(t.id, s.id, s.guestName, kind);
      }
      return;
    }

    const placed = s.bedId != null ? s : t;
    const unplaced = s.bedId != null ? t : s;
    const placedRoom = roomForBed(placed.bedId!, placed.arrivalDate);
    if (placedRoom == null) return;
    const stillPossible = await roomStillHasRoom(placedRoom, unplaced);
    if (!stillPossible) addIssue(placed.id, unplaced.id, unplaced.guestName, kind);
  }

  const seenBedPairs = new Set<string>();

  for (const s of allBookings) {
    if (s.linkedBookingId != null) {
      const t = byId.get(s.linkedBookingId);
      if (t) await evaluate(s, t, "room");
    }
    if (s.sharesBedWithBookingId != null) {
      const key = [s.id, s.sharesBedWithBookingId].sort((a, b) => a - b).join("-");
      if (!seenBedPairs.has(key)) {
        seenBedPairs.add(key);
        const t = byId.get(s.sharesBedWithBookingId);
        if (t) await evaluate(s, t, "bed");
      }
    }
  }

  return issues;
}
