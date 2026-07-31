import GridTableClient from "@/components/GridTableClient";
import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { bookings, roomCapacityOverrides, rooms } from "@/db/schema";
import { and, eq, gt, lt } from "drizzle-orm";
import { arrivals, departures, roomCapacitiesForDates, segmentsInRange } from "@/lib/occupancy";
import { buildRoomGrid } from "@/lib/bed-grid";
import { sortRooms } from "@/lib/rooms";
import { eventsInRange, layoutEventLanes } from "@/lib/event-lanes";

export const dynamic = "force-dynamic";

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Calendar-month step, clamped to the end of the target month: 31 Jan + 1
 * month is 28 Feb, not 3 Mar. Stepping by 30 days instead would drift the
 * grid off month boundaries after a few clicks, which is the whole reason
 * the month buttons exist.
 */
function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const targetMonthIndex = m - 1 + n;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, targetMonth, day)).toISOString().slice(0, 10);
}

/** Week counts offered by the view switcher. */
const WEEK_OPTIONS = [1, 2, 4] as const;
const DEFAULT_WEEKS = 2;

function parseWeeks(raw: string | undefined): number {
  const n = Number(raw);
  return WEEK_OPTIONS.includes(n as (typeof WEEK_OPTIONS)[number]) ? n : DEFAULT_WEEKS;
}

export default async function GridPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string; weeks?: string }>;
}) {
  try {
    await requireUser();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const start = params.start ?? today;
  const weeks = parseWeeks(params.weeks);
  const daysVisible = weeks * 7;

  const dates = Array.from({ length: daysVisible }, (_, i) => addDays(start, i));
  const lastDate = dates[dates.length - 1];
  const windowEnd = addDays(start, daysVisible); // exclusive

  const activeRooms = sortRooms(
    await db.select().from(rooms).where(eq(rooms.isActive, true))
  );

  const [capacities, segments, eventList, arrByDate, depByDate] = await Promise.all([
    roomCapacitiesForDates(dates),
    segmentsInRange(start, windowEnd),
    eventsInRange(start, lastDate),
    Promise.all(dates.map((d) => arrivals(d))),
    Promise.all(dates.map((d) => departures(d))),
  ]);

  const overrides = await db
    .select()
    .from(roomCapacityOverrides)
    .where(
      and(
        lt(roomCapacityOverrides.startDate, windowEnd),
        gt(roomCapacityOverrides.endDate, start)
      )
    );

  const overrideNotesByRoomDate: Record<string, Record<string, string>> = {};
  const overrideSummaryByRoom: Record<string, string[]> = {};
  for (const ov of overrides) {
    const roomKey = String(ov.roomId);
    if (!overrideNotesByRoomDate[roomKey]) overrideNotesByRoomDate[roomKey] = {};
    if (!overrideSummaryByRoom[roomKey]) overrideSummaryByRoom[roomKey] = [];
    const text = ov.note?.trim() || "Capacity override";
    const summary = `${ov.startDate} to ${ov.endDate}: ${text}`;
    if (!overrideSummaryByRoom[roomKey].includes(summary)) {
      overrideSummaryByRoom[roomKey].push(summary);
    }
    for (const d of dates) {
      if (ov.startDate <= d && ov.endDate > d) {
        overrideNotesByRoomDate[roomKey][d] = text;
      }
    }
  }

  const grid = buildRoomGrid(dates, activeRooms, capacities, segments);
  const eventLanes = layoutEventLanes(dates, eventList);

  const confirmedBookings = await db.query.bookings.findMany({
    where: eq(bookings.status, "confirmed"),
    with: { segments: true },
  });

  const gridAlerts: string[] = [];

  for (const b of confirmedBookings) {
    const overlapsWindow = b.checkInDate < windowEnd && (!b.checkOutDate || b.checkOutDate > start);
    if (!overlapsWindow) continue;
    if (b.segments.length === 0) {
      gridAlerts.push(`No room assigned: ${b.leadGuestName} (${b.checkInDate} to ${b.checkOutDate ?? "open"})`);
    }
  }

  for (const room of grid) {
    dates.forEach((d, i) => {
      const occ = room.occupancyByDate[i] ?? 0;
      const cap = room.capacityByDate[i] ?? 0;
      if (occ > cap) {
        gridAlerts.push(`Overlap/capacity issue: ${room.roomName} on ${d} (${occ}/${cap})`);
      }
    });
  }

  return (
    <div>
      <div className="tr-shell">
        <GridTableClient
          start={start}
          today={today}
          weeks={weeks}
          dates={dates}
          lastDate={lastDate}
          grid={grid}
          eventLanes={eventLanes}
          arrByDate={arrByDate}
          depByDate={depByDate}
          overrideNotesByRoomDate={overrideNotesByRoomDate}
          overrideSummaryByRoom={overrideSummaryByRoom}
          alerts={gridAlerts}
        />
      </div>
    </div>
  );
}
