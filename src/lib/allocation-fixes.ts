import { db } from "@/db";
import { beds, bedLocations, bookings, joinedBeds, rooms } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadBedCapacities } from "@/lib/bed-types";
import type { ISODate } from "@/lib/occupancy";

type BookingRow = typeof bookings.$inferSelect;

export interface EvictionStep {
  bookingId: number;
  guestName: string;
  /** "move" relocates the whole booking as-is; "split" trims it at splitDate first, then relocates just the overlapping remainder. */
  action: "move" | "split";
  /** Only set for action "split" — strictly between the booking's own arrival/departure. */
  splitDate?: ISODate;
  /** Only set for action "split" — which side of the split is the one that actually overlapped the group's needed range, and so is the one that moves; the other side stays on the original bed. */
  moveHalf?: "front" | "back";
  newBedId: number;
  newRoomName: string;
}

export interface RoomFixOption {
  roomId: number;
  roomName: string;
  /** Only the bookings that actually need to move to land here. */
  moves: { bookingId: number; guestName: string; bedId: number }[];
  /** Every "shares bed with" pair among the movers that needs a fresh join on their new beds — see applyGroupMoveProposal. */
  rejoins: [number, number][];
  /** Set only when this room only works after relocating someone ELSE out of the way first — see findGroupRoomFixOptions' second pass. */
  evictions: EvictionStep[];
}

function overlaps(aArr: ISODate, aDep: ISODate, bArr: ISODate, bDep: ISODate): boolean {
  return aArr < bDep && bArr < aDep;
}

/**
 * Every booking transitively tied to `startId` via "Sleeps near"
 * (linkedBookingId) or "Shares bed with" (sharesBedWithBookingId) — same
 * connected-components approach as the bookings table's grouped "Shares
 * with" column. A fix for one relationship in this group must never break
 * or ignore another one the same booking is party to, so this is always
 * the unit a room search works over, not just the two bookings behind
 * whichever single issue was clicked.
 */
export async function resolveConnectedGroup(startId: number): Promise<BookingRow[]> {
  const all = await db.select().from(bookings);
  const byId = new Map(all.map((b) => [b.id, b]));

  const adjacency = new Map<number, Set<number>>();
  function addEdge(x: number, y: number) {
    if (!adjacency.has(x)) adjacency.set(x, new Set());
    if (!adjacency.has(y)) adjacency.set(y, new Set());
    adjacency.get(x)!.add(y);
    adjacency.get(y)!.add(x);
  }
  for (const b of all) {
    if (b.linkedBookingId != null) addEdge(b.id, b.linkedBookingId);
    if (b.sharesBedWithBookingId != null) addEdge(b.id, b.sharesBedWithBookingId);
  }

  if (!adjacency.has(startId)) return [];
  const visited = new Set<number>([startId]);
  const stack = [startId];
  const memberIds: number[] = [];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    memberIds.push(cur);
    for (const next of adjacency.get(cur) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return memberIds.map((id) => byId.get(id)).filter((b): b is BookingRow => b != null);
}

/** Pairs within `group` that specifically need to share a bed, not just a room. */
function bedEdgesWithin(group: BookingRow[]): [BookingRow, BookingRow][] {
  const ids = new Set(group.map((b) => b.id));
  const seen = new Set<string>();
  const edges: [BookingRow, BookingRow][] = [];
  for (const b of group) {
    if (b.sharesBedWithBookingId != null && ids.has(b.sharesBedWithBookingId)) {
      const key = [b.id, b.sharesBedWithBookingId].sort((x, y) => x - y).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      const partner = group.find((g) => g.id === b.sharesBedWithBookingId)!;
      edges.push([b, partner]);
    }
  }
  return edges;
}

/**
 * All rooms that could seat the ENTIRE relationship group tied to
 * `startBookingId` at once — not just the two bookings behind whichever
 * single issue staff clicked "Fix" on — so a move never resolves one
 * requirement while leaving (or creating) another one broken for the same
 * booking. Loads every bed/room/booking fact ONCE up front and does all
 * matching in memory, rather than re-querying per candidate room per
 * member.
 *
 * Two passes: first, every room that already has enough genuinely free
 * capacity. If none do, a second pass allows AT MOST ONE other booking per
 * room to be relocated out of the way first (moved whole, or split at the
 * boundary and just the overlapping remainder moved) — but only ever
 * proposed when that eviction itself has somewhere real to land; this never
 * chains into a second eviction. Staff picks which room (and implicitly,
 * which eviction) to accept; nothing here applies anything on its own.
 */
export async function findGroupRoomFixOptions(startBookingId: number): Promise<RoomFixOption[]> {
  const fullGroup = await resolveConnectedGroup(startBookingId);
  if (fullGroup.length < 2) return [];

  // resolveConnectedGroup is a plain graph walk over linkedBookingId/
  // sharesBedWithBookingId with no awareness of dates — a guest's OLD,
  // already-departed stay can still carry a linkedBookingId from back when
  // it was made, and that pulls it into the same connected component as an
  // entirely unrelated, non-overlapping CURRENT stay. Left in, a room-fix
  // search then tries to seat that stale booking too, on ITS OWN (long
  // past) dates — which almost never has a free bed, since bed placements
  // typically don't even go back that far — and silently fails every room,
  // including ones that fit the CURRENT, actually-relevant group perfectly
  // fine. Only bookings whose stay overlaps the one the "Fix" button was
  // clicked on are a real simultaneous-occupancy constraint; drop the rest.
  const startBooking = fullGroup.find((b) => b.id === startBookingId);
  if (!startBooking) return [];
  const group = fullGroup.filter(
    (b) => b.id === startBookingId || overlaps(b.arrivalDate, b.departureDate, startBooking.arrivalDate, startBooking.departureDate)
  );
  if (group.length < 2) return [];

  const bedEdges = bedEdgesWithin(group);
  const bedEdgeMemberIds = new Set(bedEdges.flatMap(([x, y]) => [x.id, y.id]));
  const soloMembers = group.filter((b) => !bedEdgeMemberIds.has(b.id));
  const groupBookingIds = new Set(group.map((b) => b.id));

  const [allBeds, placementRows, capacities, activeJoins, allRoomRows, allBookingRows] = await Promise.all([
    db.select().from(beds),
    db.select({ bedId: bedLocations.bedId, roomId: bedLocations.roomId, startDate: bedLocations.startDate, endDate: bedLocations.endDate }).from(bedLocations),
    loadBedCapacities(),
    db.select().from(joinedBeds).where(eq(joinedBeds.mode, "double")),
    db.select().from(rooms),
    db.select().from(bookings),
  ]);

  const bedTypeById = new Map(allBeds.map((b) => [b.id, b.type]));
  const roomNameById = new Map(allRoomRows.map((r) => [r.id, r.name]));
  const roomById = new Map(allRoomRows.map((r) => [r.id, r]));

  function placedRoomOnDate(bedId: number, onDate: ISODate): number | null {
    const seg = placementRows.find((r) => r.bedId === bedId && r.startDate <= onDate && (r.endDate == null || r.endDate > onDate));
    return seg?.roomId ?? null;
  }

  // A move/fix suggestion only ever proposes a room in the SAME category as
  // wherever the group already is — see room_categories' own schema comment
  // for why this is a flat, manually-curated "these rooms are
  // interchangeable" grouping rather than a ranked upgrade/downgrade system.
  // A member with no current bed, or currently in a one-of-a-kind
  // (uncategorised) room, doesn't narrow this — only actual category
  // matches do. If NONE of the group is currently in a categorised room,
  // there's nothing to treat as equivalent, and this correctly finds no
  // candidates at all rather than falling back to "try every room."
  const referenceCategoryIds = new Set(
    group
      .map((b) => (b.bedId != null ? placedRoomOnDate(b.bedId, b.arrivalDate) : null))
      .map((roomId) => (roomId != null ? roomById.get(roomId)?.categoryId ?? null : null))
      .filter((categoryId): categoryId is number => categoryId != null)
  );
  const candidateRoomRows = allRoomRows.filter((r) => r.categoryId != null && referenceCategoryIds.has(r.categoryId));

  // Excludes only the ONE booking a candidate bed is being evaluated for —
  // never the rest of the group. A bed another group member currently sits
  // in is NOT free just because they're also being relocated: they haven't
  // actually moved yet at the point applyGroupMoveProposal checks capacity
  // (moves happen one at a time in the same transaction), so treating it as
  // free here would hand out a bed someone else is still, genuinely, in.
  // `vacated` additionally treats a specific THIRD-PARTY booking as gone —
  // the second (eviction) pass's hypothetical.
  function occupants(bedId: number, arrivalDate: ISODate, departureDate: ISODate, excludeBookingId: number, vacated: Set<number>): BookingRow[] {
    return allBookingRows.filter(
      (b) => b.bedId === bedId && b.id !== excludeBookingId && !vacated.has(b.id) && overlaps(b.arrivalDate, b.departureDate, arrivalDate, departureDate)
    );
  }

  function joinPartnerOnDate(bedId: number, arrivalDate: ISODate, departureDate: ISODate): number | null {
    for (const j of activeJoins) {
      if (j.startDate <= arrivalDate && (j.endDate == null || j.endDate >= departureDate)) {
        if (j.bed1Id === bedId) return j.bed2Id;
        if (j.bed2Id === bedId) return j.bed1Id;
      }
    }
    return null;
  }

  // A candidate bed for a relocated group member is always GENUINELY free —
  // never a stranger's spare capacity, even on a native multi-capacity bed
  // or a joined pair's empty half — same rule findGroupMoveProposal uses.
  function isBedFreeFor(bedId: number, member: BookingRow, vacated: Set<number> = new Set()): boolean {
    if (occupants(bedId, member.arrivalDate, member.departureDate, member.id, vacated).length > 0) return false;
    const partnerBedId = joinPartnerOnDate(bedId, member.arrivalDate, member.departureDate);
    if (partnerBedId != null && occupants(partnerBedId, member.arrivalDate, member.departureDate, member.id, vacated).length > 0) return false;
    return true;
  }

  function attemptRoom(room: (typeof allRoomRows)[number], vacated: Set<number>): { moves: RoomFixOption["moves"]; rejoins: [number, number][] } | null {
    const claimed = new Set<number>();
    const moves: RoomFixOption["moves"] = [];
    const rejoins: [number, number][] = [];

    for (const [x, y] of bedEdges) {
      const nativeCandidate = allBeds.find((bd) => {
        if (claimed.has(bd.id)) return false;
        if ((bedTypeById.get(bd.id) ?? "single").toLowerCase() === "single") return false;
        if (placedRoomOnDate(bd.id, x.arrivalDate) !== room.id) return false;
        return isBedFreeFor(bd.id, x, vacated) && isBedFreeFor(bd.id, y, vacated);
      });
      if (nativeCandidate) {
        claimed.add(nativeCandidate.id);
        moves.push({ bookingId: x.id, guestName: x.guestName, bedId: nativeCandidate.id });
        moves.push({ bookingId: y.id, guestName: y.guestName, bedId: nativeCandidate.id });
        continue;
      }

      const bedForX = allBeds.find(
        (bd) => !claimed.has(bd.id) && (bedTypeById.get(bd.id) ?? "").toLowerCase() === "single" && placedRoomOnDate(bd.id, x.arrivalDate) === room.id && isBedFreeFor(bd.id, x, vacated)
      );
      if (!bedForX) return null;
      claimed.add(bedForX.id);
      const bedForY = allBeds.find(
        (bd) => !claimed.has(bd.id) && (bedTypeById.get(bd.id) ?? "").toLowerCase() === "single" && placedRoomOnDate(bd.id, y.arrivalDate) === room.id && isBedFreeFor(bd.id, y, vacated)
      );
      if (!bedForY) return null;
      claimed.add(bedForY.id);
      moves.push({ bookingId: x.id, guestName: x.guestName, bedId: bedForX.id });
      moves.push({ bookingId: y.id, guestName: y.guestName, bedId: bedForY.id });
      rejoins.push([x.id, y.id]);
    }

    for (const member of soloMembers) {
      const currentRoom = member.bedId != null ? placedRoomOnDate(member.bedId, member.arrivalDate) : null;
      if (currentRoom === room.id) continue; // already here — nothing to move
      const bed = allBeds.find((bd) => !claimed.has(bd.id) && placedRoomOnDate(bd.id, member.arrivalDate) === room.id && isBedFreeFor(bd.id, member, vacated));
      if (!bed) return null;
      claimed.add(bed.id);
      moves.push({ bookingId: member.id, guestName: member.guestName, bedId: bed.id });
    }

    return { moves, rejoins };
  }

  // Finds a genuinely free bed ANYWHERE (any room) for `booking`'s own
  // dates — used to check whether an eviction candidate actually has
  // somewhere to go, so a proposal never dangles on "and then what."
  function findAnyFreeBed(arrivalDate: ISODate, departureDate: ISODate, excludeBookingId: number): { bedId: number; roomName: string } | null {
    for (const bed of allBeds) {
      const room = placedRoomOnDate(bed.id, arrivalDate);
      if (room == null) continue;
      const fakeMember = { arrivalDate, departureDate, id: excludeBookingId } as BookingRow;
      if (!isBedFreeFor(bed.id, fakeMember)) continue;
      return { bedId: bed.id, roomName: roomNameById.get(room) ?? "" };
    }
    return null;
  }

  const options: RoomFixOption[] = [];

  for (const room of candidateRoomRows) {
    const clean = attemptRoom(room, new Set());
    if (clean && clean.moves.length > 0) {
      options.push({ roomId: room.id, roomName: room.name, moves: clean.moves, rejoins: clean.rejoins, evictions: [] });
      continue;
    }

    // Second pass: is there exactly ONE non-group booking, on ONE bed this
    // room would need, whose relocation alone would unblock the whole
    // group? Try each bed this room offers in turn.
    const roomBedIds = allBeds.filter((bd) => placedRoomOnDate(bd.id, group[0].arrivalDate) === room.id).map((bd) => bd.id);
    let resolved: { moves: RoomFixOption["moves"]; rejoins: [number, number][]; eviction: EvictionStep } | null = null;

    for (const bedId of roomBedIds) {
      if (resolved) break;
      // Look at every group member who might need this exact bed, and see
      // who's currently blocking it for their specific dates.
      for (const member of group) {
        const blockers = allBookingRows.filter(
          (b) => b.bedId === bedId && !groupBookingIds.has(b.id) && overlaps(b.arrivalDate, b.departureDate, member.arrivalDate, member.departureDate)
        );
        if (blockers.length !== 1) continue;
        const blocker = blockers[0];

        // Contained entirely within the needed range — move the whole thing.
        const containedWithin = blocker.arrivalDate >= member.arrivalDate && blocker.departureDate <= member.departureDate;
        // Overlaps only at one edge — one split resolves it. A blocker that
        // spans past BOTH edges (a hole in the middle) needs two splits and
        // is deliberately out of scope here.
        const overhangsStart = blocker.arrivalDate < member.arrivalDate && blocker.departureDate <= member.departureDate;
        const overhangsEnd = blocker.arrivalDate >= member.arrivalDate && blocker.departureDate > member.departureDate;
        if (!containedWithin && !overhangsStart && !overhangsEnd) continue;

        const vacated = new Set([blocker.id]);
        const attempt = attemptRoom(room, vacated);
        if (!attempt || attempt.moves.length === 0) continue;

        if (containedWithin) {
          const spot = findAnyFreeBed(blocker.arrivalDate, blocker.departureDate, blocker.id);
          if (!spot) continue;
          resolved = {
            moves: attempt.moves,
            rejoins: attempt.rejoins,
            eviction: { bookingId: blocker.id, guestName: blocker.guestName, action: "move", newBedId: spot.bedId, newRoomName: spot.roomName },
          };
          break;
        }

        // overhangsStart: blocker started before the member's range and
        // ends at/before it — the part that overlaps is the LATER half
        // (splitDate .. blocker's own departure), so that's what moves.
        // overhangsEnd: blocker starts at/after the member's arrival and
        // runs past their departure — the overlap is the EARLIER half
        // (blocker's own arrival .. splitDate), so that one moves instead.
        const splitDate = overhangsStart ? member.arrivalDate : member.departureDate;
        const moveHalf: "front" | "back" = overhangsStart ? "back" : "front";
        const remainderArrival = overhangsStart ? splitDate : blocker.arrivalDate;
        const remainderDeparture = overhangsStart ? blocker.departureDate : splitDate;
        const spot = findAnyFreeBed(remainderArrival, remainderDeparture, blocker.id);
        if (!spot) continue;
        resolved = {
          moves: attempt.moves,
          rejoins: attempt.rejoins,
          eviction: { bookingId: blocker.id, guestName: blocker.guestName, action: "split", splitDate, moveHalf, newBedId: spot.bedId, newRoomName: spot.roomName },
        };
        break;
      }
    }

    if (resolved) {
      options.push({ roomId: room.id, roomName: room.name, moves: resolved.moves, rejoins: resolved.rejoins, evictions: [resolved.eviction] });
    }
  }

  return options.sort((a, b) => a.evictions.length - b.evictions.length || a.moves.length - b.moves.length);
}

/**
 * Applies a RoomFixOption's evictions BEFORE the group's own moves — never
 * called directly by the client; see the API route, which re-derives the
 * proposal server-side rather than trusting whatever the browser sends.
 */
/**
 * Per-eviction-step "what actually happened", in the same order as the
 * input — enough for a caller to build a full undo: a plain "move" only
 * needs the bedId it had before; a "split" also needs the id of the new
 * booking row that got created (to delete on undo) and the original
 * booking's departureDate before it was trimmed (to restore on undo).
 * Without this, undo could only ever put the GROUP's own beds back —
 * exactly the gap that used to make "Fix" allocation-issue undo incomplete.
 */
export interface EvictionResult {
  bookingId: number;
  previousBedId: number | null;
  previousDepartureDate?: ISODate;
  createdBookingId?: number;
}

export async function applyEvictions(
  evictions: EvictionStep[]
): Promise<{ ok: true; results: EvictionResult[] } | { ok: false; error: string }> {
  const results: EvictionResult[] = [];
  for (const step of evictions) {
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, step.bookingId));
    if (!booking) return { ok: false, error: `Booking ${step.bookingId} no longer exists.` };

    if (step.action === "move") {
      await db.update(bookings).set({ bedId: step.newBedId }).where(eq(bookings.id, step.bookingId));
      results.push({ bookingId: step.bookingId, previousBedId: booking.bedId });
      continue;
    }

    if (!step.splitDate || step.splitDate <= booking.arrivalDate || step.splitDate >= booking.departureDate) {
      return { ok: false, error: "Invalid split date for eviction." };
    }

    // Mirrors POST /api/bookings/[id]/split: the earlier half keeps this
    // booking's own id and bed, a new booking covers the remainder — same
    // splitGroupId propagation too, so an evicted-and-split booking still
    // shows up correctly in the other half's "jump to sibling" navigation.
    const splitGroupId = booking.splitGroupId ?? booking.id;
    await db.update(bookings).set({ departureDate: step.splitDate, splitGroupId }).where(eq(bookings.id, step.bookingId));
    const [created] = await db
      .insert(bookings)
      .values({
        guestName: booking.guestName,
        firstName: booking.firstName,
        lastName: booking.lastName,
        preferredName: booking.preferredName,
        notes: booking.notes,
        arrivalDate: step.splitDate,
        departureDate: booking.departureDate,
        linkedBookingId: booking.linkedBookingId,
        bedId: booking.bedId,
        dietariesTags: booking.dietariesTags,
        splitGroupId,
      })
      .returning();

    // Only the half that actually overlapped the group's needed range
    // moves — see moveHalf's doc comment on EvictionStep.
    const targetBookingId = step.moveHalf === "front" ? step.bookingId : created.id;
    await db.update(bookings).set({ bedId: step.newBedId }).where(eq(bookings.id, targetBookingId));

    results.push({
      bookingId: step.bookingId,
      previousBedId: booking.bedId,
      previousDepartureDate: booking.departureDate,
      createdBookingId: created.id,
    });
  }

  return { ok: true, results };
}
