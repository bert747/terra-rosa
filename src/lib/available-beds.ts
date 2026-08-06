import { db } from "@/db";
import { beds, bedLocations, bookings, joinedBeds, rooms, floors } from "@/db/schema";
import { and, eq, gt, isNull, lt, notInArray, or } from "drizzle-orm";
import { loadBedCapacities } from "@/lib/bed-types";
import type { ISODate } from "@/lib/occupancy";

export interface BedOccupant {
  bookingId: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}

export interface AvailableBed {
  id: number;
  type: string;
  roomId: number;
  roomName: string;
  floorId: number;
  floorName: string;
  /**
   * Set when picking this bed means sleeping alongside someone already
   * there for an overlapping range — a native Queen/1.5/Double with spare
   * capacity, or the still-empty other half of an active joined-singles
   * pair (picking it visually merges into their double even though it's a
   * technically separate, technically-empty bed row). Null for a bed
   * that's genuinely solo-available. Only ever filled deliberately, via
   * "Shares bed with" or the grid's own confirm-to-pair prompt.
   */
  sharesWith: BedOccupant | null;
}

/**
 * Beds offerable for a date range: placed in a real room (not an
 * "unplaced" bed with no bed_locations row — that's layout setup in
 * progress, not bookable), with spare capacity for the range, AND
 * genuinely unoccupied — a bed already sleeping someone (or the free half
 * of a joined-singles pair) is excluded by default, never offered as a
 * plain choice. Pass `onlyShareableWithBookingId` to make ONE specific
 * occupant's bed (and only theirs) reappear, annotated via `sharesWith` —
 * used when the caller already has a declared "shares bed with" partner
 * and needs to see that specific bed as a pairing option, without every
 * OTHER occupied bed in the building leaking in as well. Pass
 * `onlySingleUnshared: true` instead to also strip out empty native
 * multi-capacity beds (auto-allocate's rule for anyone who ISN'T
 * explicitly paired with anyone: only a genuinely solo Single is fair
 * game).
 */
export async function findAvailableBeds({
  arrivalDate,
  departureDate,
  excludeBookingId,
  nearRoomId,
  onlySingleUnshared,
  onlyShareableWithBookingId,
}: {
  arrivalDate: ISODate;
  departureDate: ISODate;
  excludeBookingId?: number | null;
  nearRoomId?: number | null;
  onlySingleUnshared?: boolean;
  onlyShareableWithBookingId?: number | null;
}): Promise<AvailableBed[]> {
  const [allBeds, placements, overlapping, capacities, activeJoins] = await Promise.all([
    db.select().from(beds),
    db
      .select({
        bedId: bedLocations.bedId,
        roomId: rooms.id,
        roomName: rooms.name,
        floorId: floors.id,
        floorName: floors.name,
        startDate: bedLocations.startDate,
        endDate: bedLocations.endDate,
      })
      .from(bedLocations)
      .innerJoin(rooms, eq(bedLocations.roomId, rooms.id))
      .innerJoin(floors, eq(rooms.floorId, floors.id)),
    db
      .select({
        bookingId: bookings.id,
        bedId: bookings.bedId,
        guestName: bookings.guestName,
        arrivalDate: bookings.arrivalDate,
        departureDate: bookings.departureDate,
      })
      .from(bookings)
      .where(
        and(
          lt(bookings.arrivalDate, departureDate),
          gt(bookings.departureDate, arrivalDate),
          ...(excludeBookingId ? [notInArray(bookings.id, [excludeBookingId])] : [])
        )
      ),
    loadBedCapacities(),
    db
      .select({ bed1Id: joinedBeds.bed1Id, bed2Id: joinedBeds.bed2Id, startDate: joinedBeds.startDate, endDate: joinedBeds.endDate })
      .from(joinedBeds)
      .where(and(eq(joinedBeds.mode, "double"), or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, arrivalDate)))),
  ]);

  // A bed is "placed" for this range if it has a location segment active on
  // the ARRIVAL date — same rule the bookings list uses to show a stay's
  // room (see roomNameForBooking in app/bookings/page.tsx).
  const placementByBed = new Map<number, (typeof placements)[number]>();
  for (const p of placements) {
    if (p.startDate <= arrivalDate && (p.endDate == null || p.endDate > arrivalDate)) {
      placementByBed.set(p.bedId, p);
    }
  }

  const occupantsByBed = new Map<number, BedOccupant[]>();
  for (const b of overlapping) {
    if (b.bedId == null) continue;
    const list = occupantsByBed.get(b.bedId) ?? [];
    list.push({ bookingId: b.bookingId, guestName: b.guestName, arrivalDate: b.arrivalDate, departureDate: b.departureDate });
    occupantsByBed.set(b.bedId, list);
  }

  // A join "covers" this range only if it starts on/before arrival and
  // (being open-ended, or) ends on/after departure — a join that ends
  // partway through the stay isn't a real double for these dates. Maps
  // each half of an active pair to the OTHER bed id, so a Single's "spare
  // half" occupant can be looked up even though that half's own bedId has
  // zero bookings against it.
  const joinPartnerByBed = new Map<number, number>();
  for (const j of activeJoins) {
    if (j.startDate <= arrivalDate && (j.endDate == null || j.endDate >= departureDate)) {
      joinPartnerByBed.set(j.bed1Id, j.bed2Id);
      joinPartnerByBed.set(j.bed2Id, j.bed1Id);
    }
  }

  return allBeds
    .map((bed) => {
      const placement = placementByBed.get(bed.id);
      if (!placement) return null;
      if (nearRoomId != null && placement.roomId !== nearRoomId) return null;

      const capacity = capacities.get(bed.type) ?? 1;
      const ownOccupants = occupantsByBed.get(bed.id) ?? [];
      if (ownOccupants.length >= capacity) return null; // fully booked

      const partnerBedId = joinPartnerByBed.get(bed.id);
      const partnerOccupants = partnerBedId != null ? occupantsByBed.get(partnerBedId) ?? [] : [];
      const sharesWith: BedOccupant | null = ownOccupants[0] ?? partnerOccupants[0] ?? null;
      const isShared = sharesWith != null;

      // A caller that's already declared a specific "shares bed with"
      // partner (onlyShareableWithBookingId set) only ever wants THAT one
      // occupant's bed to reappear — every other occupied bed in the
      // building must stay hidden, same as always. Without that narrowing,
      // though (a plain "Double" browse), a shared bed with spare capacity
      // is now a legitimate option in its own right — its sharesWith field
      // is exactly what lets the picker auto-fill "Shares With" and prompt
      // to confirm the pairing, rather than that bed being invisible until
      // staff already know who they're pairing with.
      if (onlyShareableWithBookingId != null && isShared && sharesWith!.bookingId !== onlyShareableWithBookingId) return null;
      if (onlySingleUnshared && (isShared || capacity > 1)) return null;

      return {
        id: bed.id,
        type: bed.type,
        roomId: placement.roomId,
        roomName: placement.roomName,
        floorId: placement.floorId,
        floorName: placement.floorName,
        sharesWith: sharesWith as BedOccupant | null,
      };
    })
    .filter((row): row is AvailableBed => row != null);
}
