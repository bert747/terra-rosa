import { and, asc, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import type { ISODate } from "@/lib/occupancy";

// ---------------------------------------------------------------------------
// Multi-day event bands for the top of the grid.
//
// Events (retreats, gatherings) span a date range and routinely overlap each
// other — the spreadsheet this app replaces has, for instance, a breathwork
// retreat starting the day a theatre week ends. So they can't share one row:
// they're packed into LANES, greedily, first-fit, exactly like Google
// Calendar's all-day section. Two events that don't overlap share a lane;
// overlapping ones push each other down.
//
// DATE CONVENTION: an event's `end_date` is INCLUSIVE — an event entered as
// 1 Dec to 7 Dec covers seven days, the last of them the 7th. This differs
// deliberately from stay_room_segments, where end_date is exclusive because
// it marks a check-out morning rather than a day the guest is present. Events
// are typed on a form labelled "Start"/"End", and the intuitive reading of
// that has to win over internal consistency with a table nobody types into.
// ---------------------------------------------------------------------------

export interface GridEvent {
  id: number;
  name: string;
  startDate: ISODate;
  /** Inclusive — see the note above. */
  endDate: ISODate;
  notes: string | null;
}

export interface EventBand {
  event: GridEvent;
  /** Index into the window's dates of this band's first visible column. */
  startIndex: number;
  /** How many columns the band spans. Always >= 1. */
  span: number;
  /** The event began before the visible window. */
  continuesBefore: boolean;
  /** The event ends after the visible window. */
  continuesAfter: boolean;
}

/**
 * Every event overlapping the inclusive date window [start, end].
 *
 * Written as two range predicates rather than a single overlap expression so
 * it's readable: keep events that start on or before the window's last day and
 * end on or after its first.
 */
export async function eventsInRange(start: ISODate, end: ISODate): Promise<GridEvent[]> {
  return db
    .select({
      id: events.id,
      name: events.name,
      startDate: events.startDate,
      endDate: events.endDate,
      notes: events.notes,
    })
    .from(events)
    .where(and(lte(events.startDate, end), gte(events.endDate, start)))
    .orderBy(asc(events.startDate), asc(events.id));
}

/**
 * Packs events into lanes over the given (contiguous, ascending) dates.
 *
 * Returns one array of bands per lane, each lane's bands in column order and
 * guaranteed not to overlap — so a lane can be rendered as a single table row
 * of colSpan'd cells.
 */
export function layoutEventLanes(dates: ISODate[], eventList: GridEvent[]): EventBand[][] {
  if (dates.length === 0) return [];

  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];

  // Longest-first within a start date, so the big retreat lands in the top
  // lane and short events tuck in underneath rather than the other way round.
  const ordered = [...eventList].sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      b.endDate.localeCompare(a.endDate) ||
      a.id - b.id
  );

  const lanes: EventBand[][] = [];

  for (const event of ordered) {
    if (event.endDate < windowStart || event.startDate > windowEnd) continue;

    // Clamp to the window, then translate dates into column indexes.
    const firstVisible = event.startDate < windowStart ? windowStart : event.startDate;
    const lastVisible = event.endDate > windowEnd ? windowEnd : event.endDate;

    const startIndex = dates.indexOf(firstVisible);
    const endIndex = dates.indexOf(lastVisible);
    // Defensive: a non-contiguous `dates` array would break the colSpan maths,
    // so skip rather than render a band in the wrong place.
    if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) continue;

    const band: EventBand = {
      event,
      startIndex,
      span: endIndex - startIndex + 1,
      continuesBefore: event.startDate < windowStart,
      continuesAfter: event.endDate > windowEnd,
    };

    // First lane with room to the right of everything already in it. Because
    // `ordered` is sorted by start date, only the lane's last band can clash.
    let lane = lanes.find((l) => {
      const last = l[l.length - 1];
      return !last || last.startIndex + last.span <= band.startIndex;
    });
    if (!lane) {
      lane = [];
      lanes.push(lane);
    }
    lane.push(band);
  }

  return lanes;
}

/**
 * Expands one lane into the cells a table row needs: bands plus the empty
 * filler between them, in column order, covering all `dateCount` columns.
 *
 * Doing this here keeps the grid's JSX free of colSpan bookkeeping.
 */
export type LaneCell = { kind: "band"; band: EventBand } | { kind: "gap"; span: number };

export function laneCells(lane: EventBand[], dateCount: number): LaneCell[] {
  const cells: LaneCell[] = [];
  let cursor = 0;
  for (const band of lane) {
    if (band.startIndex > cursor) {
      cells.push({ kind: "gap", span: band.startIndex - cursor });
    }
    cells.push({ kind: "band", band });
    cursor = band.startIndex + band.span;
  }
  if (cursor < dateCount) cells.push({ kind: "gap", span: dateCount - cursor });
  return cells;
}
