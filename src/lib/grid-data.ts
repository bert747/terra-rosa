import { db } from "@/db";
import { beds, bedLocations, bedSoloPeriods, bookings, floors, joinedBeds, rooms } from "@/db/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { DORM_STORAGE_FLOOR_NAME, DORM_STORAGE_ROOM_NAME } from "@/lib/dorm-storage";
import {
  buildRoomGrid,
  capacityByDate,
  type BedLocationSegment,
  type BedSoloSegment,
  type GridBedInfo,
  type GridBooking,
  type JoinSegment,
  type RoomGridRow,
} from "@/lib/grid";
import { eventsInRange, layoutEventLanes, type EventBand } from "@/lib/event-lanes";
import { addDays, type ISODate } from "@/lib/occupancy";
import { loadBedCapacities } from "@/lib/bed-types";

export interface UnassignedAlert {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}

export interface GridData {
  start: ISODate;
  days: number;
  dates: ISODate[];
  grid: RoomGridRow[];
  eventLanes: EventBand[][];
  arrByDate: number[];
  depByDate: number[];
  occupiedByDate: number[];
  totalByDate: number[];
  alerts: UnassignedAlert[];
  /** Target room id for the grid's "Send to Dorm Storage" bed action. */
  dormStorageRoomId: number;
}

/**
 * Get-or-create the id of the system "Dorm Storage" room, so a bed can
 * always be sent there even before anyone has moved one in. Floors/rooms are
 * otherwise entirely user-managed (see /settings/layout — no seed data), but
 * this one room is infrastructure the grid's "Send to Dorm Storage" action
 * depends on existing, so it's created lazily here instead of requiring a
 * manual setup step.
 */
async function ensureDormStorageRoomId(): Promise<number> {
  const [existingRoom] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.excludeFromCapacity, true));
  if (existingRoom) return existingRoom.id;

  let [floor] = await db.select({ id: floors.id }).from(floors).where(eq(floors.name, DORM_STORAGE_FLOOR_NAME));
  if (!floor) {
    [floor] = await db.insert(floors).values({ name: DORM_STORAGE_FLOOR_NAME }).returning({ id: floors.id });
  }
  const [room] = await db
    .insert(rooms)
    .values({ floorId: floor.id, name: DORM_STORAGE_ROOM_NAME, excludeFromCapacity: true })
    .returning({ id: rooms.id });
  return room.id;
}

/**
 * Loads and builds everything the grid needs for [start, start+days). Shared
 * by the initial server-rendered page load and the client's incremental
 * /api/grid fetches, so both always compute the grid the same way.
 */
export async function loadGridData(start: ISODate, days: number): Promise<GridData> {
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const lastDate = dates[dates.length - 1];
  const windowEnd = addDays(start, days); // exclusive

  const [dormStorageRoomId, floorRows, roomRows, allBeds, locationRows, joinRows, soloRows, eventList, capacities] = await Promise.all([
    ensureDormStorageRoomId(),
    db.select().from(floors),
    db.select().from(rooms),
    db.select({ id: beds.id, type: beds.type }).from(beds),
    db
      .select({
        bedId: bedLocations.bedId,
        roomId: bedLocations.roomId,
        startDate: bedLocations.startDate,
        endDate: bedLocations.endDate,
      })
      .from(bedLocations)
      .where(and(lt(bedLocations.startDate, windowEnd), or(isNull(bedLocations.endDate), gt(bedLocations.endDate, start)))),
    db
      .select({
        bed1Id: joinedBeds.bed1Id,
        bed2Id: joinedBeds.bed2Id,
        startDate: joinedBeds.startDate,
        endDate: joinedBeds.endDate,
        mode: joinedBeds.mode,
      })
      .from(joinedBeds)
      .where(and(lt(joinedBeds.startDate, windowEnd), or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, start)))),
    db
      .select({
        bedId: bedSoloPeriods.bedId,
        startDate: bedSoloPeriods.startDate,
        endDate: bedSoloPeriods.endDate,
      })
      .from(bedSoloPeriods)
      .where(and(lt(bedSoloPeriods.startDate, windowEnd), or(isNull(bedSoloPeriods.endDate), gt(bedSoloPeriods.endDate, start)))),
    eventsInRange(start, lastDate),
    loadBedCapacities(),
  ]);

  const floorNameById = new Map(floorRows.map((f) => [f.id, f.name]));
  const roomsForGrid = roomRows
    .map((r) => ({
      id: r.id,
      name: r.name,
      floorId: r.floorId,
      floorName: floorNameById.get(r.floorId) ?? "",
      excludeFromCapacity: r.excludeFromCapacity,
    }))
    .sort((a, b) => {
      // Dorm Storage (and anything else ever flagged excludeFromCapacity)
      // always sorts after every normal room, regardless of floor/name.
      if (a.excludeFromCapacity !== b.excludeFromCapacity) return a.excludeFromCapacity ? 1 : -1;
      return a.floorName.localeCompare(b.floorName) || a.name.localeCompare(b.name, undefined, { numeric: true });
    });

  const gridBedInfos: GridBedInfo[] = allBeds.map((b) => ({ bedId: b.id, type: b.type }));
  const gridLocationSegments: BedLocationSegment[] = locationRows;
  const gridJoinSegments: JoinSegment[] = joinRows;
  const gridSoloSegments: BedSoloSegment[] = soloRows;

  const bookingRows = await db
    .select({
      id: bookings.id,
      guestName: bookings.guestName,
      arrivalDate: bookings.arrivalDate,
      departureDate: bookings.departureDate,
      bedId: bookings.bedId,
    })
    .from(bookings)
    .where(and(lt(bookings.arrivalDate, windowEnd), gt(bookings.departureDate, start)));

  const gridBookings: GridBooking[] = bookingRows
    .filter((b): b is typeof b & { bedId: number } => b.bedId != null)
    .map((b) => ({ ...b }));

  const grid = buildRoomGrid(dates, roomsForGrid, gridBedInfos, gridLocationSegments, gridJoinSegments, gridSoloSegments, gridBookings, capacities);
  const { occupied: occupiedByDate, total: totalByDate } = capacityByDate(dates, grid);
  const eventLanes = layoutEventLanes(dates, eventList);

  const arrByDate = dates.map((d) => bookingRows.filter((b) => b.arrivalDate === d).length);
  const depByDate = dates.map((d) => bookingRows.filter((b) => b.departureDate === d).length);

  const alerts: UnassignedAlert[] = [];
  const unassigned = await db
    .select({ id: bookings.id, guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(isNull(bookings.bedId));
  for (const b of unassigned) {
    const overlaps = b.arrivalDate < windowEnd && b.departureDate > start;
    if (overlaps) {
      alerts.push(b);
    }
  }

  return { start, days, dates, grid, eventLanes, arrByDate, depByDate, occupiedByDate, totalByDate, alerts, dormStorageRoomId };
}
