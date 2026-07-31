import { roomCapacitiesForDates, segmentsInRange } from "@/lib/occupancy";

interface AvailabilityCheckInput {
  roomId: number;
  startDate: string;
  endDate: string;
  guestCount: number;
  excludeSegmentId?: number;
}

interface AvailabilityCheckResult {
  ok: boolean;
  date?: string;
  capacity?: number;
  occupied?: number;
  message?: string;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDateList(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

export async function checkRoomAvailabilityForRange(
  input: AvailabilityCheckInput
): Promise<AvailabilityCheckResult> {
  const { roomId, startDate, endDate, guestCount, excludeSegmentId } = input;

  if (!roomId || !startDate || !endDate || endDate <= startDate) {
    return { ok: false, message: "Invalid room/date range" };
  }

  const dates = isoDateList(startDate, endDate);
  if (dates.length === 0) {
    return { ok: false, message: "No nights in selected date range" };
  }

  const [capacities, segments] = await Promise.all([
    roomCapacitiesForDates(dates),
    segmentsInRange(startDate, endDate),
  ]);

  const capacityByDate = capacities.get(roomId) ?? dates.map(() => 0);

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const occupied = segments
      .filter((segment) => segment.id !== excludeSegmentId)
      .filter((segment) => segment.roomId === roomId)
      .filter((segment) => segment.startDate <= date && segment.endDate > date)
      .reduce((sum, segment) => sum + segment.guestCount, 0);

    const capacity = capacityByDate[i] ?? 0;
    if (occupied + guestCount > capacity) {
      return {
        ok: false,
        date,
        capacity,
        occupied,
        message: `Room is unavailable on ${date} (${occupied}/${capacity} already used).`,
      };
    }
  }

  return { ok: true };
}
