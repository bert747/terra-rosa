import { db } from "@/db";
import { beds, bedLocations, bookings, floors, joinedBeds, rooms } from "@/db/schema";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import {
  buildRoomGrid,
  capacityByDate,
  type BedLocationSegment,
  type GridBedInfo,
  type GridBooking,
  type JoinSegment,
  type RoomGridRow,
} from "@/lib/grid";
import { eventsInRange, layoutEventLanes, type EventBand } from "@/lib/event-lanes";
import { addDays, type ISODate } from "@/lib/occupancy";

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
  alerts: string[];
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

  const [floorRows, roomRows, allBeds, locationRows, joinRows, eventList] = await Promise.all([
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
    eventsInRange(start, lastDate),
  ]);

  const floorNameById = new Map(floorRows.map((f) => [f.id, f.name]));
  const roomsForGrid = roomRows
    .map((r) => ({ id: r.id, name: r.name, floorId: r.floorId, floorName: floorNameById.get(r.floorId) ?? "" }))
    .sort((a, b) => a.floorName.localeCompare(b.floorName) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const gridBedInfos: GridBedInfo[] = allBeds.map((b) => ({ bedId: b.id, type: b.type }));
  const gridLocationSegments: BedLocationSegment[] = locationRows;
  const gridJoinSegments: JoinSegment[] = joinRows;

  const bookingRows = await db
    .select({
      id: bookings.id,
      guestName: bookings.guestName,
      arrivalDate: bookings.arrivalDate,
      departureDate: bookings.departureDate,
      groupId: bookings.groupId,
      bedId: bookings.bedId,
    })
    .from(bookings)
    .where(and(lt(bookings.arrivalDate, windowEnd), gt(bookings.departureDate, start)));

  const gridBookings: GridBooking[] = bookingRows
    .filter((b): b is typeof b & { bedId: number } => b.bedId != null)
    .map((b) => ({ ...b }));

  const grid = buildRoomGrid(dates, roomsForGrid, gridBedInfos, gridLocationSegments, gridJoinSegments, gridBookings);
  const { occupied: occupiedByDate, total: totalByDate } = capacityByDate(dates, grid);
  const eventLanes = layoutEventLanes(dates, eventList);

  const arrByDate = dates.map((d) => bookingRows.filter((b) => b.arrivalDate === d).length);
  const depByDate = dates.map((d) => bookingRows.filter((b) => b.departureDate === d).length);

  const alerts: string[] = [];
  const unassigned = await db
    .select({ id: bookings.id, guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(isNull(bookings.bedId));
  for (const b of unassigned) {
    const overlaps = b.arrivalDate < windowEnd && b.departureDate > start;
    if (overlaps) {
      alerts.push(`No bed assigned: ${b.guestName} (${b.arrivalDate} to ${b.departureDate})`);
    }
  }

  return { start, days, dates, grid, eventLanes, arrByDate, depByDate, occupiedByDate, totalByDate, alerts };
}
