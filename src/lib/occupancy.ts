// ---------------------------------------------------------------------------
// Small date-window helpers shared by the grid and event lanes.
//
// The old occupancy/capacity/meal-count math that used to live here was
// built entirely on stay_room_segments, room_capacity_overrides and
// bookings.status/guest_count — all removed in the nuke-and-pave rebuild
// (see drizzle/0001_nuke_and_pave.sql). Physical layout is now independent
// of bookings, and a booking occupies exactly one bed, so none of that
// derivation is needed any more.
// ---------------------------------------------------------------------------

export type ISODate = string; // "YYYY-MM-DD"

function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

/** Returns the ISO date string for the day before the given ISO date. */
export function previousDay(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return toISODate(d);
}

/** Returns the ISO date string for the day after the given ISO date. */
export function nextDay(date: ISODate): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return toISODate(d);
}

/** Returns the ISO date string `n` days after (or before, if negative) the given ISO date. */
export function addDays(date: ISODate, n: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}
