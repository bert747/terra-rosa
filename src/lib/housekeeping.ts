import { and, eq, gt, lte } from "drizzle-orm";
import { db } from "@/db";
import { bookings, operationalNotes, rooms, stayRoomSegments } from "@/db/schema";
import { previousDay, roomCapacity, type ISODate } from "./occupancy";

// ---------------------------------------------------------------------------
// Housekeeping instructions, derived per room per date from:
//   (a) bed-count change vs the previous day
//       -> explicit move strings with source and destination rooms where possible
//   (b) occupancy status: Departure / Arrival / Stayover / Vacant
//   (c) any operational_notes attached to that room/date
//
// This is read-only derived data — nothing here writes to the database.
// ---------------------------------------------------------------------------

export type OccupancyStatus = "departure" | "arrival" | "stayover" | "vacant";

export interface HousekeepingRoomEntry {
  roomId: number;
  roomName: string;
  locationOrType: string | null;
  status: OccupancyStatus;
  bedCountToday: number;
  bedCountYesterday: number;
  bedInstruction: string | null;
  roomSetupText: string;
  makeSingleBeds: number;
  finalBedCount: number;
  notes: string[];
}

async function bookingIdsForRoomOnDate(roomId: number, date: ISODate): Promise<Set<number>> {
  const rows = await db
    .select({ bookingId: stayRoomSegments.bookingId })
    .from(stayRoomSegments)
    .innerJoin(bookings, eq(stayRoomSegments.bookingId, bookings.id))
    .where(
      and(
        eq(stayRoomSegments.roomId, roomId),
        eq(bookings.status, "confirmed"),
        lte(stayRoomSegments.startDate, date),
        gt(stayRoomSegments.endDate, date)
      )
    );
  return new Set(rows.map((r) => r.bookingId));
}

function bedLabel(count: number): string {
  return `${count} bed${count === 1 ? "" : "s"}`;
}

function resolveRoomMoveInstructions(entries: HousekeepingRoomEntry[]): Map<number, string[]> {
  const sources = entries
    .map((entry) => ({
      roomId: entry.roomId,
      roomName: entry.roomName,
      remaining: Math.max(0, entry.bedCountYesterday - entry.bedCountToday),
    }))
    .filter((entry) => entry.remaining > 0);

  const destinations = entries
    .map((entry) => ({
      roomId: entry.roomId,
      roomName: entry.roomName,
      remaining: Math.max(0, entry.bedCountToday - entry.bedCountYesterday),
    }))
    .filter((entry) => entry.remaining > 0);

  const instructionsByRoom = new Map<number, string[]>();

  for (const source of sources) {
    for (const destination of destinations) {
      if (source.remaining <= 0) break;
      if (destination.remaining <= 0) continue;

      const moved = Math.min(source.remaining, destination.remaining);
      source.remaining -= moved;
      destination.remaining -= moved;

      const text = `Move ${bedLabel(moved)} from ${source.roomName} to ${destination.roomName}`;
      instructionsByRoom.set(source.roomId, [...(instructionsByRoom.get(source.roomId) ?? []), text]);
      instructionsByRoom.set(destination.roomId, [...(instructionsByRoom.get(destination.roomId) ?? []), text]);
    }
  }

  // Fallback when a source/destination could not be paired exactly (data drift).
  for (const source of sources) {
    if (source.remaining <= 0) continue;
    const text = `Move ${bedLabel(source.remaining)} from ${source.roomName} to storage`;
    instructionsByRoom.set(source.roomId, [...(instructionsByRoom.get(source.roomId) ?? []), text]);
  }
  for (const destination of destinations) {
    if (destination.remaining <= 0) continue;
    const text = `Move ${bedLabel(destination.remaining)} from storage to ${destination.roomName}`;
    instructionsByRoom.set(destination.roomId, [...(instructionsByRoom.get(destination.roomId) ?? []), text]);
  }

  return instructionsByRoom;
}

function singleBedsLabel(count: number): string {
  return `${count} single ${count === 1 ? "bed" : "beds"}`;
}

/** Builds the housekeeping list for every active room on `date`. */
export async function housekeepingForDate(date: ISODate): Promise<HousekeepingRoomEntry[]> {
  const yesterday = previousDay(date);
  const activeRooms = await db.select().from(rooms).where(eq(rooms.isActive, true));

  const notesRows = await db
    .select()
    .from(operationalNotes)
    .where(eq(operationalNotes.date, date));

  const notesByRoom = new Map<number, string[]>();
  for (const note of notesRows) {
    if (note.roomId == null) continue;
    const list = notesByRoom.get(note.roomId) ?? [];
    list.push(note.noteText);
    notesByRoom.set(note.roomId, list);
  }

  const entries: HousekeepingRoomEntry[] = [];

  for (const room of activeRooms) {
    const [todayBookingIds, yesterdayBookingIds, bedCountToday, bedCountYesterday] =
      await Promise.all([
        bookingIdsForRoomOnDate(room.id, date),
        bookingIdsForRoomOnDate(room.id, yesterday),
        roomCapacity(room.id, date),
        roomCapacity(room.id, yesterday),
      ]);

    const hasToday = todayBookingIds.size > 0;
    const hasYesterday = yesterdayBookingIds.size > 0;

    // Departure: someone was here yesterday but a different/no booking today
    // in this exact room. Arrival: booking present today that wasn't here
    // yesterday. Stayover: same booking(s) present both days. Vacant: neither.
    let status: OccupancyStatus;
    if (!hasToday && !hasYesterday) {
      status = "vacant";
    } else {
      const departed = [...yesterdayBookingIds].some((id) => !todayBookingIds.has(id));
      const arrived = [...todayBookingIds].some((id) => !yesterdayBookingIds.has(id));
      if (departed && arrived) {
        // Room turned over same day — treat as both; surfaced via notes,
        // but classify primarily as a departure so housekeeping cleans it.
        status = "departure";
      } else if (departed) {
        status = "departure";
      } else if (arrived) {
        status = "arrival";
      } else {
        status = "stayover";
      }
    }

    entries.push({
      roomId: room.id,
      roomName: room.name,
      locationOrType: room.locationOrType,
      status,
      bedCountToday,
      bedCountYesterday,
      bedInstruction: null,
      roomSetupText: singleBedsLabel(bedCountToday),
      makeSingleBeds: Math.max(0, bedCountToday - bedCountYesterday),
      finalBedCount: bedCountToday,
      notes: notesByRoom.get(room.id) ?? [],
    });
  }

  const moveInstructionsByRoom = resolveRoomMoveInstructions(entries);
  return entries.map((entry) => ({
    ...entry,
    bedInstruction: moveInstructionsByRoom.get(entry.roomId)?.join(". ") ?? null,
  }));
}

export const STATUS_LABELS: Record<OccupancyStatus, string> = {
  departure: "Departure",
  arrival: "Arrival",
  stayover: "Stayover",
  vacant: "Vacant",
};
