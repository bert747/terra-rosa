import { and, eq, gt, lt } from "drizzle-orm";
import { roomCapacityOverrides } from "@/db/schema";

// ---------------------------------------------------------------------------
// Dated changes to a room's bed count.
//
// Two ways a bed can move between rooms:
//
//   * PERMANENTLY — the `room_beds` row is reassigned to the other room and
//     both rooms' `default_bed_count` is resynced. No override involved.
//   * FOR A DATE RANGE — `room_beds` is left alone (the bed physically belongs
//     to the first room) and a `room_capacity_overrides` row on each room
//     records the borrowed capacity: -n on the source, +n on the target. That
//     is what `applyCapacityDelta` below does.
//
// Overrides are per (room, date range) and the database has — or should have,
// via the migration noted in src/db/schema.ts — a GIST exclusion constraint
// forbidding two overrides overlapping on one room. So a delta can't just be
// inserted: any existing override overlapping the range has to be read (to get
// the capacity we're adding to), deleted, and its outside-the-range parts
// re-inserted. That's the split/merge dance here.
//
// Runs of dates whose new capacity equals `default_bed_count` get no override
// at all — capacity falls back to the default when nothing covers the date, so
// writing one would be redundant rows saying nothing.
// ---------------------------------------------------------------------------

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dates in the half-open range [start, end) — end is a check-out morning. */
export function dateRange(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

export interface CapacityDeltaInput {
  roomId: number;
  /** Inclusive. */
  startDate: string;
  /** Exclusive, matching stay_room_segments.end_date. */
  endDate: string;
  /** Beds to add (positive) or take away (negative) over the range. */
  delta: number;
  defaultBedCount: number;
  note: string;
}

export interface CapacityDeltaResult {
  ok: boolean;
  error?: string;
  /** Effective capacity per date after the change, aligned with the range. */
  capacityByDate?: number[];
}

/**
 * Adds `delta` beds to a room for [startDate, endDate), rewriting whatever
 * overrides already cover any of those dates.
 *
 * Fails (changing nothing) if the room doesn't have `-delta` beds to give up on
 * every date in the range, so a move can never invent or destroy beds.
 *
 * `tx` should be a transaction when both sides of a move are being applied, so
 * the two rooms' overrides commit or roll back together.
 */
export async function applyCapacityDelta(
  tx: any,
  input: CapacityDeltaInput
): Promise<CapacityDeltaResult> {
  const { roomId, startDate, endDate, delta, defaultBedCount, note } = input;

  if (startDate >= endDate) {
    return { ok: false, error: "startDate must be before endDate" };
  }

  const dates = dateRange(startDate, endDate);
  if (dates.length === 0) {
    return { ok: false, error: "The date range covers no nights" };
  }

  const overlapping = await tx
    .select()
    .from(roomCapacityOverrides)
    .where(
      and(
        eq(roomCapacityOverrides.roomId, roomId),
        lt(roomCapacityOverrides.startDate, endDate),
        gt(roomCapacityOverrides.endDate, startDate)
      )
    );

  // Capacity as it stands today: override wins over the default, same rule as
  // roomCapacity() in src/lib/occupancy.ts.
  const before = dates.map(() => defaultBedCount);
  for (const override of overlapping) {
    dates.forEach((d, i) => {
      if (override.startDate <= d && override.endDate > d) {
        before[i] = override.bedCount;
      }
    });
  }

  const after = before.map((count) => count + delta);
  const shortIndex = after.findIndex((count) => count < 0);
  if (shortIndex !== -1) {
    return {
      ok: false,
      error: `Only ${before[shortIndex]} bed(s) in this room on ${dates[shortIndex]} — cannot move ${-delta}.`,
    };
  }

  // Clear the range, keeping the parts of existing overrides that fall outside
  // it so a two-week override isn't lost to a two-day move.
  for (const override of overlapping) {
    await tx.delete(roomCapacityOverrides).where(eq(roomCapacityOverrides.id, override.id));

    if (override.startDate < startDate) {
      await tx.insert(roomCapacityOverrides).values({
        roomId,
        startDate: override.startDate,
        endDate: startDate,
        bedCount: override.bedCount,
        note: override.note,
      });
    }
    if (override.endDate > endDate) {
      await tx.insert(roomCapacityOverrides).values({
        roomId,
        startDate: endDate,
        endDate: override.endDate,
        bedCount: override.bedCount,
        note: override.note,
      });
    }
  }

  // Write one override per run of equal capacity, skipping runs that match the
  // default (no override needed — the default already says that).
  let runStart = 0;
  for (let i = 1; i <= after.length; i++) {
    if (i < after.length && after[i] === after[runStart]) continue;

    if (after[runStart] !== defaultBedCount) {
      await tx.insert(roomCapacityOverrides).values({
        roomId,
        startDate: dates[runStart],
        endDate: i < after.length ? dates[i] : endDate,
        bedCount: after[runStart],
        note,
      });
    }
    runStart = i;
  }

  return { ok: true, capacityByDate: after };
}
