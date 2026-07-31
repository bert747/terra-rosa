import { and, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { guardianPresenceOverrides, type GuardianPresenceOverride } from "@/db/schema";

export interface GuardianPresenceWindow {
  bookingId: number;
  startDate: string;
  endDate: string | null;
  isOccupied: boolean;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isDateInsideWindow(date: string, startDate: string, endDate: string | null): boolean {
  if (date < startDate) return false;
  if (!endDate) return true;
  return date < endDate;
}

export function guardianOccupiesOnDate(
  date: string,
  overrides: GuardianPresenceOverride[]
): boolean {
  let occupied = true;
  const sorted = [...overrides].sort(
    (a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id
  );

  for (const ov of sorted) {
    if (isDateInsideWindow(date, ov.startDate, ov.endDate)) {
      occupied = ov.isOccupied;
    }
  }
  return occupied;
}

export async function guardianOverridesInRange(
  bookingIds: number[],
  startDate: string,
  endDateExclusive: string
): Promise<Map<number, GuardianPresenceOverride[]>> {
  const map = new Map<number, GuardianPresenceOverride[]>();
  if (bookingIds.length === 0) return map;

  const rows = await db
    .select()
    .from(guardianPresenceOverrides)
    .where(
      and(
        inArray(guardianPresenceOverrides.bookingId, bookingIds),
        lt(guardianPresenceOverrides.startDate, endDateExclusive),
        or(
          isNull(guardianPresenceOverrides.endDate),
          gt(guardianPresenceOverrides.endDate, startDate)
        )
      )
    );

  for (const row of rows) {
    const list = map.get(row.bookingId);
    if (list) list.push(row);
    else map.set(row.bookingId, [row]);
  }

  return map;
}

export function nextTripsFromOverrides(
  overrides: GuardianPresenceOverride[],
  fromDate: string
): Array<{ startDate: string; endDate: string | null }> {
  return overrides
    .filter((ov) => !ov.isOccupied)
    .filter((ov) => !ov.endDate || ov.endDate >= fromDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id)
    .map((ov) => ({ startDate: ov.startDate, endDate: ov.endDate }));
}

export function normalizePresenceWindow(startDate: string, endDate: string | null, noEndDate: boolean) {
  if (noEndDate) return { startDate, endDate: null };
  if (!endDate) return { startDate, endDate: addDays(startDate, 1) };
  return { startDate, endDate };
}

export function ensureValidPresenceWindow(startDate: string, endDate: string | null): string | null {
  if (!startDate) return "Start date is required";
  if (endDate && endDate <= startDate) return "End date must be after start date";
  return null;
}
