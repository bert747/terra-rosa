import { db } from "@/db";
import { beds, bookings, joinedBeds, rooms } from "@/db/schema";
import { eq } from "drizzle-orm";
import { findAvailableBeds, type AvailableBed } from "@/lib/available-beds";
import type { ISODate } from "@/lib/occupancy";

type BookingRow = typeof bookings.$inferSelect;

export interface GroupMoveProposal {
  /** Stable key so the UI can dedupe/track a proposal across a re-render. */
  key: string;
  guestNames: string[];
  fromRoomName: string;
  toRoomId: number;
  toRoomName: string;
  moves: { bookingId: number; guestName: string; bedId: number }[];
  /** Set when two of the moving bookings were paired via "Shares bed with" — re-establish the join on their new beds. */
  rejoinBookingIds: [number, number] | null;
}

/**
 * The people already occupying the room a new arrival was hoping to join:
 * the "sleeps near" target, plus that target's "shares bed with" partner if
 * any (a couple sharing a joined double). Both must already have a real bed
 * — an unplaced target means there's no room to be full of in the first
 * place, so the caller never has a reason to call this without one.
 */
export async function resolveExistingGroup(nearBookingId: number): Promise<BookingRow[]> {
  const [linked] = await db.select().from(bookings).where(eq(bookings.id, nearBookingId));
  if (!linked || linked.bedId == null) return [];
  const group = [linked];
  if (linked.sharesBedWithBookingId != null) {
    const [partner] = await db.select().from(bookings).where(eq(bookings.id, linked.sharesBedWithBookingId));
    if (partner && partner.bedId != null) group.push(partner);
  }
  return group;
}

/**
 * Looks for ONE other room that can seat the whole group at once — the
 * already-placed occupants plus the new arrival — each in a bed matching
 * the type they currently have (a couple keeps sharing a Single-pair
 * double, not a Double bed neither of them asked for). Tries rooms in id
 * order and returns the first that fits everyone; there's no ranking by
 * "closest" or "fewest people moved" since a hostel this size only ever
 * has a handful of rooms to check.
 */
export async function findGroupMoveProposal(
  newBooking: BookingRow,
  group: BookingRow[],
  excludeRoomId: number
): Promise<GroupMoveProposal | null> {
  const allBedIds = group.map((b) => b.bedId!).filter((id) => id != null);
  const bedTypeById = new Map<number, string>();
  if (allBedIds.length > 0) {
    const bedRows = await db.select({ id: beds.id, type: beds.type }).from(beds);
    for (const b of bedRows) bedTypeById.set(b.id, b.type);
  }

  const members: { booking: BookingRow; preferredType: string }[] = [
    ...group.map((b) => ({ booking: b, preferredType: (bedTypeById.get(b.bedId!) ?? "single").toLowerCase() })),
    { booking: newBooking, preferredType: "single" },
  ];

  const allRooms = await db.select().from(rooms);
  const [fromRoom] = await db.select().from(rooms).where(eq(rooms.id, excludeRoomId));

  for (const room of allRooms) {
    if (room.id === excludeRoomId) continue;

    const claimed = new Set<number>();
    const assignment = new Map<number, AvailableBed>();
    let fits = true;

    for (const member of members) {
      const available = await findAvailableBeds({
        arrivalDate: member.booking.arrivalDate as ISODate,
        departureDate: member.booking.departureDate as ISODate,
        excludeBookingId: member.booking.id,
        nearRoomId: room.id,
      });
      // A relocated member always gets a genuinely free bed of their own —
      // never one that's already sleeping someone else, even a stranger's
      // spare half of a native Queen/1.5/Double or a joined-singles pair.
      const pick = available.find((b) => !claimed.has(b.id) && b.sharesWith == null && b.type.toLowerCase() === member.preferredType);
      if (!pick) {
        fits = false;
        break;
      }
      claimed.add(pick.id);
      assignment.set(member.booking.id, pick);
    }

    if (!fits) continue;

    const moves = members.map((m) => ({
      bookingId: m.booking.id,
      guestName: m.booking.guestName,
      bedId: assignment.get(m.booking.id)!.id,
    }));

    let rejoinBookingIds: [number, number] | null = null;
    if (group.length === 2 && group[0].sharesBedWithBookingId === group[1].id) {
      rejoinBookingIds = [group[0].id, group[1].id];
    }

    return {
      key: `group-${[...group.map((g) => g.id), newBooking.id].sort((a, b) => a - b).join("-")}-${room.id}`,
      guestNames: members.map((m) => m.booking.guestName),
      fromRoomName: fromRoom?.name ?? "the full room",
      toRoomId: room.id,
      toRoomName: room.name,
      moves,
      rejoinBookingIds,
    };
  }

  return null;
}

/**
 * Applies a previously-computed GroupMoveProposal: closes any joined-bed
 * pairing on the moving bookings' OLD beds, moves each booking to its new
 * bed, and — for every pair in `rejoins` that were a "shares bed with"
 * couple — re-joins their NEW beds into a fresh double. Almost always at
 * most one pair, but a large relocated group can contain more than one
 * couple needing to move together. Re-checks capacity on each target bed
 * right before writing, since the proposal may be stale by the time staff
 * confirms it.
 */
/** A join closed (deleted, or truncated to end today) as a side effect of moving a booking off one of its two beds — see the "closing" pass below. Enough for a caller to undo it: recreate outright if `deleted`, else PATCH the endDate back. */
export interface ClosedJoinInfo {
  id: number;
  bed1Id: number;
  bed2Id: number;
  mode: "double" | "solo";
  startDate: ISODate;
  /** The join's endDate BEFORE closing (null if it was open-ended). */
  endDate: ISODate | null;
  /** true if the row was deleted outright (it hadn't started yet); false if only its endDate was set to today. */
  deleted: boolean;
}

/** A join freshly created by `rejoins` — enough for a caller to undo it (DELETE by id). */
export interface CreatedJoinInfo {
  id: number;
  bed1Id: number;
  bed2Id: number;
}

export async function applyGroupMoveProposal(proposal: {
  moves: { bookingId: number; bedId: number }[];
  rejoins: [number, number][];
}): Promise<{ ok: true; closedJoins: ClosedJoinInfo[]; createdJoins: CreatedJoinInfo[] } | { ok: false; error: string }> {
  const { checkBedCapacity } = await import("@/lib/booking-guard");
  const { nextTimelineEventDate } = await import("@/lib/next-timeline-event");

  return db.transaction(async (tx) => {
    const oldBedIds: number[] = [];
    for (const move of proposal.moves) {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, move.bookingId));
      if (!booking) return { ok: false, error: `Booking ${move.bookingId} no longer exists.` };
      const check = await checkBedCapacity(move.bedId, booking.arrivalDate, booking.departureDate, [move.bookingId]);
      if (!check.ok) return { ok: false, error: check.error ?? "Bed no longer available." };
      if (booking.bedId != null) oldBedIds.push(booking.bedId);
    }

    const today = new Date().toISOString().slice(0, 10);
    const closedJoins: ClosedJoinInfo[] = [];
    if (oldBedIds.length > 0) {
      const activeJoins = await tx.select().from(joinedBeds);
      const closing = new Set<number>();
      for (const j of activeJoins) {
        if (!oldBedIds.includes(j.bed1Id) && !oldBedIds.includes(j.bed2Id)) continue;
        if (j.endDate != null && j.endDate <= today) continue;
        closing.add(j.id);
      }
      for (const joinId of closing) {
        const [j] = await tx.select().from(joinedBeds).where(eq(joinedBeds.id, joinId));
        if (!j) continue;
        // A join that hasn't started yet (including one scheduled to start
        // TODAY — there's been no actual occupancy under it yet) has no
        // "up to today" span worth keeping; it was never really active, so
        // it's deleted outright, same as the same-day case always did.
        // Setting endDate: today on one whose startDate is still in the
        // FUTURE would create an end-before-start row that's never valid
        // for any date — exactly the corrupt rows this used to leave
        // behind, which then went on to poison anything reading this bed's
        // join history (grid pairing, nextTimelineEventDate, …).
        const deleted = j.startDate >= today;
        closedJoins.push({ id: j.id, bed1Id: j.bed1Id, bed2Id: j.bed2Id, mode: j.mode, startDate: j.startDate, endDate: j.endDate, deleted });
        if (deleted) {
          await tx.delete(joinedBeds).where(eq(joinedBeds.id, joinId));
        } else {
          await tx.update(joinedBeds).set({ endDate: today }).where(eq(joinedBeds.id, joinId));
        }
      }
    }

    for (const move of proposal.moves) {
      await tx.update(bookings).set({ bedId: move.bedId }).where(eq(bookings.id, move.bookingId));
    }

    const createdJoins: CreatedJoinInfo[] = [];
    for (const [aId, bId] of proposal.rejoins) {
      const [a] = await tx.select().from(bookings).where(eq(bookings.id, aId));
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, bId));
      if (a?.bedId != null && b?.bedId != null && a.bedId !== b.bedId) {
        const startDate = a.arrivalDate < b.arrivalDate ? a.arrivalDate : b.arrivalDate;
        const endDate = await nextTimelineEventDate([a.bedId, b.bedId], startDate);
        const [created] = await tx
          .insert(joinedBeds)
          .values({ bed1Id: a.bedId, bed2Id: b.bedId, startDate, endDate, mode: "double" })
          .returning();
        createdJoins.push({ id: created.id, bed1Id: created.bed1Id, bed2Id: created.bed2Id });
      }
    }

    return { ok: true, closedJoins, createdJoins };
  });
}
