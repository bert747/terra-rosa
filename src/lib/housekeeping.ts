import { db } from "@/db";
import { beds, bedLocations, bedSoloPeriods, bookings, joinedBeds, rooms } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { loadGridData } from "@/lib/grid-data";
import type { RoomGridRow } from "@/lib/grid";
import type { ISODate } from "@/lib/occupancy";

export interface LayoutCheckEntry {
  label: string;
  state: "occupied" | "empty";
  count: number;
}

export interface RoomHousekeeping {
  roomName: string;
  floorName: string;
  /** Bed/room-structure changes taking effect today — moves, joins, splits, solo switches. */
  moverTasks: string[];
  /** Expected end-of-day state, bed-type + occupied/empty counts. Only for
   *  rooms that actually need checking today — see buildHousekeepingSheet. */
  layoutCheck: LayoutCheckEntry[];
}

function bump(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function pluralize(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

/** Turns tallied "label -> count" counts into structured entries, in a stable order. */
function describeCounts(counts: Map<string, { label: string; state: string; count: number }>): LayoutCheckEntry[] {
  return Array.from(counts.values())
    .sort((a, b) => a.label.localeCompare(a.label) || a.state.localeCompare(b.state))
    .map((c) => ({ label: pluralize(c.label, c.count), state: c.state as "occupied" | "empty", count: c.count }));
}

/** Per-room bed-type/occupied-empty tally for a single date, from the same grid the dorm board renders. */
function buildLayoutCheck(grid: RoomGridRow[]): Map<number, LayoutCheckEntry[]> {
  const byRoom = new Map<number, LayoutCheckEntry[]>();

  for (const room of grid) {
    const counts = new Map<string, { label: string; state: string; count: number }>();
    const addCount = (label: string, state: string) => {
      const key = `${label}|${state}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { label, state, count: 1 });
    };

    for (const unit of room.units) {
      const firstCell = unit.slots[0]?.cells[0];
      if (!firstCell || firstCell.state === "inactive") continue;

      // Secondary half of a Solo Double (joined or native) contributes
      // nothing of its own — it's not an independently bookable spot today.
      if (firstCell.blockedBySoloJoin) continue;

      const soloMerged = unit.soloByDate?.[0] === true || (firstCell.joinBadge?.mode === "solo" && firstCell.joinBadge.isPrimary);
      if (soloMerged) {
        addCount(`${unit.label} (Solo Double)`, firstCell.state === "booked" ? "occupied" : "empty");
        continue;
      }

      for (const slot of unit.slots) {
        const cell = slot.cells[0];
        if (!cell || cell.state === "inactive" || cell.blockedBySoloJoin) continue;
        addCount(unit.label, cell.state === "booked" ? "occupied" : "empty");
      }
    }

    byRoom.set(room.roomId, describeCounts(counts));
  }

  return byRoom;
}

export async function buildHousekeepingSheet(date: ISODate): Promise<RoomHousekeeping[]> {
  const [gridData, roomRows, bedRows, movedInToday, joinsStartingToday, joinsEndingToday, soloStartingToday, soloEndingToday, arrivingToday] =
    await Promise.all([
      loadGridData(date, 1),
      db.select().from(rooms),
      db.select().from(beds),
      db.select().from(bedLocations).where(eq(bedLocations.startDate, date)),
      db.select().from(joinedBeds).where(eq(joinedBeds.startDate, date)),
      db.select().from(joinedBeds).where(eq(joinedBeds.endDate, date)),
      db.select().from(bedSoloPeriods).where(eq(bedSoloPeriods.startDate, date)),
      db.select().from(bedSoloPeriods).where(eq(bedSoloPeriods.endDate, date)),
      db.select().from(bookings).where(eq(bookings.arrivalDate, date)),
    ]);

  const roomNameById = new Map(roomRows.map((r) => [r.id, r.name]));
  const bedTypeById = new Map(bedRows.map((b) => [b.id, b.type]));
  const layoutByRoom = buildLayoutCheck(gridData.grid);

  const moverTasksByRoom = new Map<number, string[]>();
  const addMover = (roomId: number | null, text: string) => {
    if (roomId == null) return;
    const list = moverTasksByRoom.get(roomId) ?? [];
    list.push(text);
    moverTasksByRoom.set(roomId, list);
  };

  // Bed moves: a bed_locations row starting today, paired with the segment
  // for that same bed that ended exactly today — if there's no such prior
  // segment, this is the bed's very first placement, not a "move".
  for (const seg of movedInToday) {
    const [prev] = await db
      .select()
      .from(bedLocations)
      .where(and(eq(bedLocations.bedId, seg.bedId), eq(bedLocations.endDate, date)));
    // Same room on both sides of the split isn't a physical move (e.g. a
    // location row that got split for bookkeeping reasons without the bed
    // actually going anywhere) — nothing for housekeeping to lift.
    if (!prev || prev.roomId === seg.roomId) continue;
    const bedType = bedTypeById.get(seg.bedId) ?? "bed";
    const fromRoom = roomNameById.get(prev.roomId) ?? "unknown room";
    const toRoom = roomNameById.get(seg.roomId) ?? "unknown room";
    addMover(prev.roomId, `Move 1 ${bedType} to ${toRoom}`);
    addMover(seg.roomId, `Receive 1 ${bedType} from ${fromRoom}`);
  }

  for (const j of joinsStartingToday) {
    const bed1Type = bedTypeById.get(j.bed1Id) ?? "single";
    const bed2Type = bedTypeById.get(j.bed2Id) ?? "single";
    const roomId = movedInToday.find((s) => s.bedId === j.bed1Id)?.roomId ?? (await currentRoomIdFor(j.bed1Id, date));
    const verb = j.mode === "solo" ? "join as a Solo Double" : "join and make as a double";
    addMover(roomId, `Join 1 ${bed1Type} and 1 ${bed2Type} — ${verb}`);
  }

  for (const j of joinsEndingToday) {
    const bed1Type = bedTypeById.get(j.bed1Id) ?? "single";
    const bed2Type = bedTypeById.get(j.bed2Id) ?? "single";
    const roomId = await currentRoomIdFor(j.bed1Id, date);
    addMover(roomId, `Split joined ${bed1Type}/${bed2Type} back into singles`);
  }

  for (const s of soloStartingToday) {
    const bedType = bedTypeById.get(s.bedId) ?? "bed";
    const roomId = await currentRoomIdFor(s.bedId, date);
    addMover(roomId, `Switch ${bedType} to Solo Double`);
  }

  for (const s of soloEndingToday) {
    const bedType = bedTypeById.get(s.bedId) ?? "bed";
    const roomId = await currentRoomIdFor(s.bedId, date);
    addMover(roomId, `Switch ${bedType} back to Couple`);
  }

  // Beds are made up on arrival day (linen delivery timing means a
  // departure-day changeover can't be relied on), so the layout check only
  // needs to cover rooms that actually need eyes on them today: somewhere
  // is arriving (bed must be made and ready), or the room's physical setup
  // just changed (move/join/split/solo-switch, already in moverTasksByRoom).
  // Every other occupied-but-unchanged room is identical to yesterday's
  // check and isn't worth re-listing.
  const needsCheckRoomIds = new Set(moverTasksByRoom.keys());
  for (const b of arrivingToday) {
    if (b.bedId == null) continue;
    const roomId = await currentRoomIdFor(b.bedId, date);
    if (roomId != null) needsCheckRoomIds.add(roomId);
  }

  const result: RoomHousekeeping[] = roomRows
    .filter((r) => !r.excludeFromCapacity)
    .map((r) => ({
      roomName: r.name,
      floorName: "",
      moverTasks: moverTasksByRoom.get(r.id) ?? [],
      layoutCheck: needsCheckRoomIds.has(r.id) ? layoutByRoom.get(r.id) ?? [] : [],
    }))
    .filter((r) => r.moverTasks.length > 0 || r.layoutCheck.length > 0);

  return result;
}

/** Whatever room a bed sits in as of `date`, per bed_locations. */
async function currentRoomIdFor(bedId: number, date: ISODate): Promise<number | null> {
  const [seg] = await db
    .select({ roomId: bedLocations.roomId })
    .from(bedLocations)
    .where(and(eq(bedLocations.bedId, bedId), eq(bedLocations.startDate, date)));
  if (seg) return seg.roomId;
  const rows = await db.select().from(bedLocations).where(eq(bedLocations.bedId, bedId));
  const active = rows.find((r) => r.startDate <= date && (r.endDate == null || r.endDate > date));
  return active?.roomId ?? null;
}
