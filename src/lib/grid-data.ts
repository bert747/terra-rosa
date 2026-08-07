import { db } from "@/db";
import { beds, bedLocations, bedSoloPeriods, bookings, floors, guestCategories, joinedBeds, rooms } from "@/db/schema";
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
import { findAllocationIssues } from "@/lib/allocation-issues";
import { findPlannedChanges, type PlannedChangeLine } from "@/lib/bed-moves";
import { loadAllSplitGroups, type SplitSiblingBooking } from "@/lib/split-siblings";

export interface UnassignedAlert {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}

export interface IssueAlert {
  id: number;
  guestName: string;
  issues: { otherBookingId: number; otherGuestName: string; kind: "room" | "bed" }[];
}

export interface IssueGroup {
  /** Any one member's booking id — enough to resolve the whole group again server-side (see /api/bookings/[id]/allocation-fix-options). */
  bookingId: number;
  guestNames: string[];
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
  issues: IssueAlert[];
  issueGroups: IssueGroup[];
  /** Every future bed move or bed-type/join change already scheduled — see the grid's "Planned Changes" button. Not scoped to the viewed window; it's a global, always-current list. */
  plannedChanges: PlannedChangeLine[];
  /** Every split-booking lineage in the system, keyed by splitGroupId (as a string — see the object-vs-Map note near where this is built) — not scoped to the viewed window, since a sibling can be anywhere on the calendar. Powers the grid pill's "jump to the other part" arrows. */
  splitGroups: Record<string, SplitSiblingBooking[]>;
  /** Target room id for the grid's "Send to Dorm Storage" bed action. */
  dormStorageRoomId: number;
}

/**
 * Reconstructs connected groups of allocation issues — every issue is
 * flagged on BOTH bookings it involves (see findAllocationIssues), so the
 * issues list alone already contains every edge needed to reconstruct
 * connected groups, no extra query. Three people all missing the same
 * requirement reads as one line, not three. Shared by loadGridData (scoped
 * to the viewed window) and GET /api/alerts (unscoped, every current/future
 * issue), which both need the exact same grouping logic.
 */
export function buildIssueGroups(issues: IssueAlert[]): IssueGroup[] {
  const guestNameById = new Map(issues.map((i) => [i.id, i.guestName]));
  const adjacency = new Map<number, Set<number>>();
  for (const i of issues) {
    for (const rel of i.issues) {
      if (!adjacency.has(i.id)) adjacency.set(i.id, new Set());
      adjacency.get(i.id)!.add(rel.otherBookingId);
    }
  }
  const visited = new Set<number>();
  const groups: IssueGroup[] = [];
  for (const i of issues) {
    if (visited.has(i.id)) continue;
    const stack = [i.id];
    const memberIds: number[] = [];
    visited.add(i.id);
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
    groups.push({ bookingId: memberIds[0], guestNames: memberIds.map((id) => guestNameById.get(id) ?? "?") });
  }
  return groups;
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
  const today = new Date().toISOString().slice(0, 10);

  const [dormStorageRoomId, floorRows, roomRows, allBeds, locationRows, joinRows, soloRows, eventList, capacities, allocationIssues, plannedChanges, splitGroupsMap] = await Promise.all([
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
    findAllocationIssues(),
    findPlannedChanges(),
    loadAllSplitGroups(),
  ]);
  const splitGroups: Record<string, SplitSiblingBooking[]> = Object.fromEntries(splitGroupsMap);

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
      firstName: bookings.firstName,
      preferredName: bookings.preferredName,
      notes: bookings.notes,
      arrivalDate: bookings.arrivalDate,
      departureDate: bookings.departureDate,
      bedId: bookings.bedId,
      splitGroupId: bookings.splitGroupId,
      linkedBookingId: bookings.linkedBookingId,
      sharesBedWithBookingId: bookings.sharesBedWithBookingId,
      guestCategoryId: bookings.guestCategoryId,
    })
    .from(bookings)
    .where(and(lt(bookings.arrivalDate, windowEnd), gt(bookings.departureDate, start)));

  // Colour lookup for the pill — see GridBooking.guestCategoryColour. Loads
  // every category (not just active ones) since an existing booking can
  // still be tagged with a since-deactivated category and must keep
  // showing its colour.
  const guestCategoryRows = await db.select({ id: guestCategories.id, colour: guestCategories.colour }).from(guestCategories);
  const guestCategoryColourById = new Map(guestCategoryRows.map((c) => [c.id, c.colour]));

  // A "Sleeps near"/"Shares bed with" partner can fall outside the current
  // window (already checked out, or arriving later than what's loaded) —
  // a lightweight all-bookings id->name lookup so the pill annotation
  // still resolves the partner's CURRENT name even then, rather than only
  // working when both halves happen to be in view at once.
  const allGuestNames = await db.select({ id: bookings.id, guestName: bookings.guestName }).from(bookings);
  const guestNameById = new Map(allGuestNames.map((b) => [b.id, b.guestName]));
  function relationshipFor(b: (typeof bookingRows)[number]): { kind: "room" | "bed"; otherGuestName: string } | undefined {
    if (b.sharesBedWithBookingId != null) {
      const otherGuestName = guestNameById.get(b.sharesBedWithBookingId);
      if (otherGuestName) return { kind: "bed", otherGuestName };
    }
    if (b.linkedBookingId != null) {
      const otherGuestName = guestNameById.get(b.linkedBookingId);
      if (otherGuestName) return { kind: "room", otherGuestName };
    }
    return undefined;
  }

  const gridBookings: GridBooking[] = bookingRows
    .filter((b): b is typeof b & { bedId: number } => b.bedId != null)
    .map((b) => ({
      ...b,
      allocationIssues: allocationIssues.get(b.id) ?? [],
      relationship: relationshipFor(b),
      guestCategoryColour: b.guestCategoryId != null ? guestCategoryColourById.get(b.guestCategoryId) ?? null : null,
    }));

  const grid = buildRoomGrid(dates, roomsForGrid, gridBedInfos, gridLocationSegments, gridJoinSegments, gridSoloSegments, gridBookings, capacities, today);
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

  const issues: IssueAlert[] = bookingRows
    .filter((b) => (allocationIssues.get(b.id) ?? []).length > 0)
    .map((b) => ({ id: b.id, guestName: b.guestName, issues: allocationIssues.get(b.id)! }));

  const issueGroups: IssueGroup[] = buildIssueGroups(issues);

  return { start, days, dates, grid, eventLanes, arrByDate, depByDate, occupiedByDate, totalByDate, alerts, issues, issueGroups, plannedChanges, splitGroups, dormStorageRoomId };
}
