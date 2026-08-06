import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bedLocations, bookings, joinedBeds } from "@/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { isIsoDate } from "@/lib/dates";
import { findAvailableBeds } from "@/lib/available-beds";

export const dynamic = "force-dynamic";

// Beds a booking form should actually offer: placed in a real room and with
// spare capacity for the given date range (see findAvailableBeds), further
// narrowed by "Sleeps near" room and the Bed Type dropdown (Single/Double),
// with an Auto-Join Fallback pairing when "Double" has nothing pre-made.
export async function GET(req: NextRequest) {
  const arrivalDate = req.nextUrl.searchParams.get("arrival") ?? "";
  const departureDate = req.nextUrl.searchParams.get("departure") ?? "";
  const excludeBookingIdRaw = req.nextUrl.searchParams.get("excludeBookingId");
  const excludeBookingId = excludeBookingIdRaw ? Number(excludeBookingIdRaw) : null;
  // "Sleeps near" — when set, only beds in the SAME ROOM as this OTHER
  // booking's own bed are offered, so picking a linked guest actually
  // narrows the bed choice down to beds physically near them instead of
  // just being a label with no effect on placement.
  const nearBookingIdRaw = req.nextUrl.searchParams.get("nearBookingId");
  const nearBookingId = nearBookingIdRaw ? Number(nearBookingIdRaw) : null;
  // "Shares bed with" — when set, the ONE bed already belonging to this
  // specific declared partner is allowed to reappear as an option (see
  // findAvailableBeds's onlyShareableWithBookingId) — every OTHER occupied
  // bed in the building stays hidden regardless.
  const shareBedWithBookingIdRaw = req.nextUrl.searchParams.get("shareBedWithBookingId");
  const shareBedWithBookingId = shareBedWithBookingIdRaw ? Number(shareBedWithBookingIdRaw) : null;
  // "single" or "double" — see the Bed Type dropdown on the booking forms.
  // Omitted entirely = no type filter (used by callers that don't offer the
  // dropdown, e.g. the Shares Bed With partner-bed lookup).
  const bedTypeFilter = req.nextUrl.searchParams.get("bedType") === "single" || req.nextUrl.searchParams.get("bedType") === "double"
    ? (req.nextUrl.searchParams.get("bedType") as "single" | "double")
    : null;

  if (!isIsoDate(arrivalDate) || !isIsoDate(departureDate) || departureDate <= arrivalDate) {
    return NextResponse.json({ error: "Valid arrival/departure dates are required" }, { status: 400 });
  }

  let nearRoomId: number | null = null;
  if (nearBookingId) {
    const [nearBooking] = await db.select({ bedId: bookings.bedId }).from(bookings).where(eq(bookings.id, nearBookingId));
    if (nearBooking?.bedId != null) {
      // Whichever room that bed sat in AS OF the arrival date being
      // searched — not necessarily its current room, since a bed can move.
      const locationRows = await db.select().from(bedLocations).where(eq(bedLocations.bedId, nearBooking.bedId));
      const active = locationRows.find((r) => r.startDate <= arrivalDate && (r.endDate == null || r.endDate > arrivalDate));
      nearRoomId = active?.roomId ?? null;
    }
  }

  const [available, activeJoins] = await Promise.all([
    findAvailableBeds({ arrivalDate, departureDate, excludeBookingId, nearRoomId, onlyShareableWithBookingId: shareBedWithBookingId }),
    db
      .select({ bed1Id: joinedBeds.bed1Id, bed2Id: joinedBeds.bed2Id, startDate: joinedBeds.startDate, endDate: joinedBeds.endDate, mode: joinedBeds.mode })
      .from(joinedBeds)
      .where(and(eq(joinedBeds.mode, "double"), or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, arrivalDate)))),
  ]);

  // A join "covers" this booking's whole range only if it starts on/before
  // arrival and (being open-ended, or) ends on/after departure — a join that
  // ends partway through the stay isn't a real double for these dates.
  const joinedSingleBedIds = new Set<number>();
  for (const j of activeJoins) {
    if (j.startDate <= arrivalDate && (j.endDate == null || j.endDate >= departureDate)) {
      joinedSingleBedIds.add(j.bed1Id);
      joinedSingleBedIds.add(j.bed2Id);
    }
  }

  const filtered = available.filter((bed) => {
    const isJoinedDouble = joinedSingleBedIds.has(bed.id);
    if (bedTypeFilter === "single") {
      // Only plain Singles that aren't currently forming a double.
      return bed.type.toLowerCase() === "single" && !isJoinedDouble;
    }
    if (bedTypeFilter === "double") {
      // Only native 1.5-beds, or a Single already joined into a double.
      const isHalfBed = bed.type.toLowerCase() !== "single";
      return isHalfBed || isJoinedDouble;
    }
    return true;
  });

  const rows = filtered.map((bed) => ({
    id: bed.id,
    type: bed.type,
    room: { roomId: bed.roomId, roomName: bed.roomName, floorId: bed.floorId, floorName: bed.floorName },
    sharesWith: bed.sharesWith,
  }));

  // Auto-Join Fallback: if "Double" was requested and nothing above
  // qualifies, offer pairs of plain free Singles that happen to share a
  // room — picking one lets the booking form join them into a double on
  // save (see POST /api/bookings `partnerBedId`).
  const fallbackPairs: { bedId: number; partnerBedId: number; roomId: number; roomName: string }[] = [];
  if (bedTypeFilter === "double" && rows.length === 0) {
    const freeSingles = available.filter((bed) => bed.type.toLowerCase() === "single" && !joinedSingleBedIds.has(bed.id));

    const byRoom = new Map<number, typeof freeSingles>();
    for (const bed of freeSingles) {
      const list = byRoom.get(bed.roomId) ?? [];
      list.push(bed);
      byRoom.set(bed.roomId, list);
    }
    for (const [roomId, roomBeds] of byRoom) {
      if (roomBeds.length < 2) continue;
      const sorted = [...roomBeds].sort((a, b) => a.id - b.id);
      fallbackPairs.push({ bedId: sorted[0].id, partnerBedId: sorted[1].id, roomId, roomName: sorted[0].roomName });
    }
  }

  // Callers that pass `bedType` get the richer { rows, fallbackPairs } shape
  // (they need to know about fallback pairs); everyone else keeps getting
  // the plain array they've always gotten.
  return NextResponse.json(bedTypeFilter ? { rows, fallbackPairs } : rows);
}
