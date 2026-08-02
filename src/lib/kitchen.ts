import type { ISODate } from "@/lib/occupancy";

export type MealType = "breakfast" | "lunch" | "dinner";

export interface MealBooking {
  id: number;
  arrivalDate: ISODate;
  departureDate: ISODate;
  dietariesTags: string[] | null;
}

/**
 * Who's in the house for a given meal on a given date — the three rules are
 * deliberately NOT the same "arrival <= date < departure" test the grid uses
 * for occupied nights, because a meal isn't a night:
 *   - Dinner: arrival <= date < departure — the guest is in the house for
 *     the evening of every night they're booked, INCLUDING their arrival
 *     day (they showed up in time for dinner) but not their departure day
 *     (they've already left by evening).
 *   - Breakfast: arrival < date <= departure — the mirror of dinner. A
 *     guest doesn't get breakfast the morning they arrive (they weren't
 *     there yet), but DOES get it the morning they leave (checkout is after
 *     breakfast).
 *   - Lunch: arrival < date < departure — neither the arrival nor the
 *     departure day, only full days in between.
 * Get any one of these backwards and every count is off by exactly the
 * number of same-day arrivals/departures — the classic off-by-one this is
 * guarding against.
 */
export function guestsForMeal(bookings: MealBooking[], date: ISODate, meal: MealType): MealBooking[] {
  return bookings.filter((b) => {
    if (meal === "dinner") return b.arrivalDate <= date && date < b.departureDate;
    if (meal === "breakfast") return b.arrivalDate < date && date <= b.departureDate;
    return b.arrivalDate < date && date < b.departureDate;
  });
}

/** Tag -> count, across a set of bookings' own dietariesTags arrays. */
export function aggregateDietaryTags(bookings: MealBooking[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const b of bookings) {
    for (const tag of b.dietariesTags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
