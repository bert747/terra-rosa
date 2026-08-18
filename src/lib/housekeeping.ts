import { db } from "@/db";
import { beds, bedLocations, bedSoloPeriods, bookings, events, joinedBeds, rooms } from "@/db/schema";
import { and, eq, gte, lte } from "drizzle-orm";
import { loadGridData } from "@/lib/grid-data";
import type { RoomGridRow } from "@/lib/grid";
import { nightsBetween } from "@/lib/dates";
import type { ISODate } from "@/lib/occupancy";

export interface BedTypeCount {
  bedType: string;
  made: number;
  total: number;
}

export interface RoomBedCount {
  roomName: string;
  byType: BedTypeCount[];
}

export interface ArrivalEntry {
  guestName: string;
  roomName: string;
}

export interface DepartureEntry {
  guestName: string;
}

/** "Family, day 1 of 3" — every event covering this date, not just ones starting/ending on it. */
export interface OngoingEvent {
  name: string;
  dayOfEvent: number;
  totalDays: number;
}

export interface HousekeepingSheet {
  /** "Move 2 Singles from Ensuite 1 to Ashrami" — already netted, so a bed swapping back and forth for no real physical change never appears. */
  moverTasks: string[];
  arrivals: ArrivalEntry[];
  /**
   * Arrivals that are really a split booking's continuation into a new room
   * (see bookings.splitGroupId) — the guest didn't leave and come back, so
   * listing them as ordinary arrivals overstates who's actually checking in
   * today. Kept separate rather than filtered out because housekeeping still
   * needs to know the new bed is occupied (see roomsToMake).
   */
  roomMoves: ArrivalEntry[];
  departures: DepartureEntry[];
  eventsOngoing: OngoingEvent[];
  /** Only rooms with at least one arrival today — see buildHousekeepingSheet. */
  roomsToMake: RoomBedCount[];
}

type BedLocationRow = { bedId: number; roomId: number; startDate: ISODate; endDate: ISODate | null };

/**
 * Whatever room a bed sits in as of `date`, per bed_locations — looked up
 * against an already-fetched full table (see buildHousekeepingSheet, which
 * calls this several times per date and previously re-queried the database
 * on every call).
 */
function currentRoomIdFor(bedId: number, date: ISODate, allLocations: BedLocationRow[]): number | null {
  const exact = allLocations.find((r) => r.bedId === bedId && r.startDate === date);
  if (exact) return exact.roomId;
  const active = allLocations.find((r) => r.bedId === bedId && r.startDate <= date && (r.endDate == null || r.endDate > date));
  return active?.roomId ?? null;
}

/**
 * Physical bed count per room, broken down by the type housekeeping actually
 * makes up — a joined Couple Double (mode "double") is dressed and counted
 * as ONE double bed, but a Solo Double (mode "solo") is still two separate
 * single mattresses physically, just sold as one spot, so both halves keep
 * counting as "Single" here (mirrors housekeepingBedType's own fold, which
 * only relabels mode "double" joins). Unlike countRoomSpots (guest capacity
 * — a solo-merged pair is ONE spot), this is "how many beds are there to
 * make", which doesn't collapse on solo mode.
 */
function countRoomSpotsByType(grid: RoomGridRow[]): Map<number, Map<string, number>> {
  const byRoom = new Map<number, Map<string, number>>();
  for (const room of grid) {
    const byType = new Map<string, number>();
    const seenPairs = new Set<string>();
    for (const unit of room.units) {
      const cell = unit.slots[0]?.cells[0];
      if (!cell || cell.state === "inactive") continue;

      if (unit.partnerUnitKey != null && cell.joinBadge?.mode === "double") {
        const pairKey = [unit.key, unit.partnerUnitKey].sort().join("|");
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        byType.set("Double", (byType.get("Double") ?? 0) + 1);
        continue;
      }

      byType.set(unit.label, (byType.get(unit.label) ?? 0) + 1);
    }
    byRoom.set(room.roomId, byType);
  }
  return byRoom;
}

/**
 * Every bed-location segment that started today, paired with the segment
 * for that same bed ending today — that pairing is what makes it a real
 * move (a location row starting today with no such predecessor is the
 * bed's very first placement, not a move; same room on both sides is a
 * bookkeeping split, nobody carries anything).
 */
async function collectRawMoves(date: ISODate): Promise<{ bedId: number; bedType: string; fromRoomId: number; toRoomId: number }[]> {
  const [movedInToday, bedTypeRows] = await Promise.all([
    db.select().from(bedLocations).where(eq(bedLocations.startDate, date)),
    db.select().from(beds),
  ]);
  const bedTypeById = new Map(bedTypeRows.map((b) => [b.id, b.type]));

  const raw: { bedId: number; bedType: string; fromRoomId: number; toRoomId: number }[] = [];
  for (const seg of movedInToday) {
    const [prev] = await db
      .select()
      .from(bedLocations)
      .where(and(eq(bedLocations.bedId, seg.bedId), eq(bedLocations.endDate, date)));
    if (!prev || prev.roomId === seg.roomId) continue;
    raw.push({ bedId: seg.bedId, bedType: bedTypeById.get(seg.bedId) ?? "bed", fromRoomId: prev.roomId, toRoomId: seg.roomId });
  }
  return raw;
}

/**
 * What matters to whoever's carrying beds isn't the literal chain of
 * bed_locations rows the database recorded, it's each room's NET count
 * change for the day — physically, a bed is interchangeable with any other
 * of the same type, so "Ensuite 1 → Infirmary" followed by "Infirmary →
 * Ashrami" is indistinguishable from "Ensuite 1 → Ashrami" (Infirmary's own
 * count never actually changed; it was just a way-station in the data).
 * Netting only OPPOSITE-DIRECTION pairs between the same two rooms (the
 * previous approach) missed exactly that chain case. This instead nets to a
 * single count per (bedType, room) — negative means that room gave beds
 * away today, positive means it received them — then greedily pairs off
 * whichever rooms are short against whichever are over, independent of
 * which specific room-to-room hops the data happened to record.
 */
function netMoves(raw: { bedType: string; fromRoomId: number; toRoomId: number }[], roomNameById: Map<number, string>): string[] {
  const netByTypeRoom = new Map<string, number>();
  const bump = (bedType: string, roomId: number, delta: number) => {
    const key = `${bedType}|${roomId}`;
    netByTypeRoom.set(key, (netByTypeRoom.get(key) ?? 0) + delta);
  };
  for (const m of raw) {
    bump(m.bedType, m.fromRoomId, -1);
    bump(m.bedType, m.toRoomId, 1);
  }

  const byType = new Map<string, { roomId: number; net: number }[]>();
  for (const [key, net] of netByTypeRoom) {
    if (net === 0) continue;
    const [bedType, roomIdStr] = key.split("|");
    const list = byType.get(bedType) ?? [];
    list.push({ roomId: Number(roomIdStr), net });
    byType.set(bedType, list);
  }

  const tasks: { bedType: string; fromRoomId: number; toRoomId: number; count: number }[] = [];
  for (const [bedType, rooms] of byType) {
    const sources = rooms
      .filter((r) => r.net < 0)
      .map((r) => ({ roomId: r.roomId, remaining: -r.net }))
      .sort((a, b) => (roomNameById.get(a.roomId) ?? "").localeCompare(roomNameById.get(b.roomId) ?? ""));
    const sinks = rooms
      .filter((r) => r.net > 0)
      .map((r) => ({ roomId: r.roomId, remaining: r.net }))
      .sort((a, b) => (roomNameById.get(a.roomId) ?? "").localeCompare(roomNameById.get(b.roomId) ?? ""));

    let si = 0;
    let ti = 0;
    while (si < sources.length && ti < sinks.length) {
      const source = sources[si];
      const sink = sinks[ti];
      const count = Math.min(source.remaining, sink.remaining);
      tasks.push({ bedType, fromRoomId: source.roomId, toRoomId: sink.roomId, count });
      source.remaining -= count;
      sink.remaining -= count;
      if (source.remaining === 0) si += 1;
      if (sink.remaining === 0) ti += 1;
    }
  }

  return tasks
    .sort((a, b) => (roomNameById.get(a.fromRoomId) ?? "").localeCompare(roomNameById.get(b.fromRoomId) ?? ""))
    .map((t) => {
      const fromName = roomNameById.get(t.fromRoomId) ?? "unknown room";
      const toName = roomNameById.get(t.toRoomId) ?? "unknown room";
      const label = t.count === 1 ? t.bedType : `${t.bedType}s`;
      return `Move ${t.count} ${label} from ${fromName} to ${toName}`;
    });
}

export async function buildHousekeepingSheet(date: ISODate): Promise<HousekeepingSheet> {
  const [
    gridData,
    roomRows,
    bedRows,
    joinsStartingToday,
    joinsEndingToday,
    soloStartingToday,
    soloEndingToday,
    arrivingToday,
    departingToday,
    eventsOngoingToday,
    rawMoves,
    allBedLocations,
  ] = await Promise.all([
    loadGridData(date, 1),
    db.select().from(rooms),
    db.select().from(beds),
    db.select().from(joinedBeds).where(eq(joinedBeds.startDate, date)),
    db.select().from(joinedBeds).where(eq(joinedBeds.endDate, date)),
    db.select().from(bedSoloPeriods).where(eq(bedSoloPeriods.startDate, date)),
    db.select().from(bedSoloPeriods).where(eq(bedSoloPeriods.endDate, date)),
    db.select().from(bookings).where(eq(bookings.arrivalDate, date)),
    db.select().from(bookings).where(eq(bookings.departureDate, date)),
    // Every event COVERING this date, not just ones starting/ending on it —
    // the Daily Sheet shows "Family, day 2 of 5" for the whole run, not just
    // the two boundary days.
    db.select().from(events).where(and(lte(events.startDate, date), gte(events.endDate, date))),
    collectRawMoves(date),
    // Fetched once, up front — currentRoomIdFor is called several times per
    // date below (arrivals, Beds to Make, join start/end folds); resolving
    // each call against this in-memory set instead of re-querying avoids an
    // N+1 pattern for what's really a handful of lookups against one table.
    db.select().from(bedLocations),
  ]);

  // A join row whose endDate isn't strictly after its startDate is
  // degenerate (never actually active for any date — coversDate would
  // always reject it) — most likely a leftover from a since-corrected
  // edit. Filtering it out here, rather than trusting the raw
  // startDate/endDate equality queries above, stops a stale row like that
  // from spuriously reporting a "make/break down a double" event on its
  // nominal startDate.
  const joinsStartingTodayValid = joinsStartingToday.filter((j) => j.endDate == null || j.endDate > j.startDate);
  const joinsEndingTodayValid = joinsEndingToday.filter((j) => j.endDate != null && j.endDate > j.startDate);

  const roomNameById = new Map(roomRows.map((r) => [r.id, r.name]));
  // Same floor-then-rank order the grid itself displays rooms in (see
  // grid-data.ts's own sort) — gridData.grid is already sorted that way, so
  // "Beds to make" just borrows its room order instead of re-deriving it.
  const roomOrderById = new Map(gridData.grid.map((r, i) => [r.roomId, i]));
  const bedTypeById = new Map(bedRows.map((b) => [b.id, b.type]));
  // Rooms with showInBedsToMake off (staff/owner quarters — see rooms' own
  // schema comment) never appear in "Beds to move" or "Beds to make":
  // whoever sleeps there handles their own bed, so housekeeping shouldn't be
  // told to carry/make one for them.
  const excludedRoomIds = new Set(roomRows.filter((r) => !r.showInBedsToMake).map((r) => r.id));
  const spotsByRoomType = countRoomSpotsByType(gridData.grid);
  // Joins that neither start nor end today but are still active need
  // checking too, for the arrivals bed-type fold — cheap enough to just
  // pull them all rather than reason about which subset might matter.
  const allJoins = await db.select().from(joinedBeds).where(eq(joinedBeds.mode, "double"));

  function housekeepingBedType(bedId: number | null): string {
    if (bedId == null) return "bed";
    const raw = bedTypeById.get(bedId) ?? "bed";
    if (raw.toLowerCase() !== "single") return raw;
    // Solo vs Couple Double is a booking/pricing distinction only — to
    // housekeeping it's the same double sheet + duvet either way.
    const joined = allJoins.some((j) => (j.bed1Id === bedId || j.bed2Id === bedId) && j.startDate <= date && (j.endDate == null || j.endDate > date));
    return joined ? "Double" : "Single";
  }

  // Strictly literal room-to-room bed carries only — a join/split doesn't
  // carry a bed anywhere, so that work lives entirely in Beds to Make below,
  // never here. Moves touching an excluded room (see excludedRoomIds above)
  // are dropped entirely, not just relabelled — nobody needs to carry
  // anything to/from a room that makes its own beds.
  const movesExcludingStaffRooms = rawMoves.filter((m) => !excludedRoomIds.has(m.fromRoomId) && !excludedRoomIds.has(m.toRoomId));
  const moverTasks = netMoves(movesExcludingStaffRooms, roomNameById);

  // Solo <-> Couple switches never change what housekeeping actually does
  // (still a made-up double either way) — deliberately not counted as "made"
  // work; the room's already-made double just changes who it's sold to,
  // nothing physical happens today.
  void soloStartingToday;
  void soloEndingToday;

  // A departing booking whose split lineage root also has an arrival today
  // (see arrivals' roomMoves fold below) is the same stay picking up in a
  // new bed, not a real departure — the guest never actually leaves, so
  // listing them under Departures would be misleading.
  const arrivingSplitRoots = new Set(arrivingToday.map((b) => b.splitGroupId ?? b.id));
  const departures: DepartureEntry[] = departingToday
    .filter((b) => !arrivingSplitRoots.has(b.splitGroupId ?? b.id))
    .map((b) => ({ guestName: b.guestName }))
    .sort((a, b) => a.guestName.localeCompare(b.guestName));

  // Beds to Make, broken down by type — an arrival into a bed is "made" work
  // for whatever type that bed folds to today (Double if it's part of an
  // active Couple Double join, else its own raw type). A join starting today
  // with no accompanying arrival (an existing guest's beds get pushed
  // together mid-stay) is ALSO made work — one Double — unless an arrival on
  // one of its two beds already counted it via the fold above. A join ending
  // today un-makes the double back into two singles, which is equally real
  // work the other direction.
  const madeByRoomType = new Map<number, Map<string, number>>();
  function addMade(roomId: number, bedType: string, count = 1) {
    if (excludedRoomIds.has(roomId)) return;
    const forRoom = madeByRoomType.get(roomId) ?? new Map<string, number>();
    forRoom.set(bedType, (forRoom.get(bedType) ?? 0) + count);
    madeByRoomType.set(roomId, forRoom);
  }

  const arrivalBedIds = new Set(arrivingToday.map((b) => b.bedId).filter((id): id is number => id != null));
  // Two guests arriving the same day into the two HALVES of the same Couple
  // Double (one booking per underlying single bed) is still only ONE
  // physical bed made up — without this, each arrival independently folds
  // to "Double" and the pair gets counted twice ("2 of 1", nonsensical).
  const countedDoublePairs = new Set<string>();
  // A departing booking today whose split lineage root reappears on an
  // arriving booking today means that arrival is the same stay picking up in
  // a new bed, not a fresh check-in — see guestsForMeal's identical
  // boundary-date logic in kitchen.ts.
  const departingSplitRoots = new Set(departingToday.map((b) => b.splitGroupId ?? b.id));

  // Single pass over arrivingToday covers both the Arrivals/Room moves lists
  // and the "made" fold below — both need the same per-booking roomId,
  // previously resolved via two separate loops each re-deriving it.
  const arrivals: ArrivalEntry[] = [];
  const roomMoves: ArrivalEntry[] = [];
  for (const b of arrivingToday) {
    const roomId = b.bedId != null ? currentRoomIdFor(b.bedId, date, allBedLocations) : null;
    const entry: ArrivalEntry = {
      guestName: b.guestName,
      roomName: roomId != null ? roomNameById.get(roomId) ?? "Unassigned" : "Unassigned",
    };
    const isRoomMove = departingSplitRoots.has(b.splitGroupId ?? b.id);
    (isRoomMove ? roomMoves : arrivals).push(entry);

    if (roomId == null) continue;
    const bedType = housekeepingBedType(b.bedId);
    if (bedType === "Double" && b.bedId != null) {
      const join = allJoins.find(
        (j) => (j.bed1Id === b.bedId || j.bed2Id === b.bedId) && j.startDate <= date && (j.endDate == null || j.endDate > date)
      );
      if (join) {
        const pairKey = [join.bed1Id, join.bed2Id].sort((a, c) => a - c).join("-");
        if (countedDoublePairs.has(pairKey)) continue;
        countedDoublePairs.add(pairKey);
      }
    }
    addMade(roomId, bedType);
  }
  arrivals.sort((a, b) => a.roomName.localeCompare(b.roomName) || a.guestName.localeCompare(b.guestName));
  roomMoves.sort((a, b) => a.roomName.localeCompare(b.roomName) || a.guestName.localeCompare(b.guestName));

  for (const j of joinsStartingTodayValid) {
    if (j.mode !== "double") continue;
    if (arrivalBedIds.has(j.bed1Id) || arrivalBedIds.has(j.bed2Id)) continue; // already folded into "Double" above
    const roomId = rawMoves.find((m) => m.bedId === j.bed1Id)?.toRoomId ?? currentRoomIdFor(j.bed1Id, date, allBedLocations);
    if (roomId == null) continue;
    addMade(roomId, "Double");
  }
  for (const j of joinsEndingTodayValid) {
    if (j.mode !== "double") continue;
    const roomId = currentRoomIdFor(j.bed1Id, date, allBedLocations);
    if (roomId == null) continue;
    addMade(roomId, "Single", 2);
  }

  const roomsToMake: RoomBedCount[] = [...madeByRoomType.entries()]
    // Floor-then-layout order (see roomOrderById above), not alphabetical —
    // matches how staff actually walk the building. A room absent from the
    // grid (shouldn't happen, but a stale/deleted room's id could linger in
    // madeByRoomType) sorts after every known room rather than crashing.
    .sort(([roomIdA], [roomIdB]) => (roomOrderById.get(roomIdA) ?? Infinity) - (roomOrderById.get(roomIdB) ?? Infinity))
    .map(([roomId, madeMap]) => {
      const totalMap = spotsByRoomType.get(roomId) ?? new Map<string, number>();
      const types = new Set([...madeMap.keys(), ...totalMap.keys()]);
      const byType = [...types]
        .map((bedType) => ({
          bedType,
          made: madeMap.get(bedType) ?? 0,
          total: totalMap.get(bedType) ?? madeMap.get(bedType) ?? 0,
        }))
        .sort((a, b) => a.bedType.localeCompare(b.bedType));
      return { roomName: roomNameById.get(roomId) ?? "unknown room", byType };
    });

  return {
    moverTasks,
    arrivals,
    roomMoves,
    departures,
    eventsOngoing: eventsOngoingToday.map((e) => ({
      name: e.name,
      dayOfEvent: nightsBetween(e.startDate, date) + 1,
      totalDays: nightsBetween(e.startDate, e.endDate) + 1,
    })),
    roomsToMake,
  };
}
