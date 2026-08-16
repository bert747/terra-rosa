import type { ISODate } from "@/lib/occupancy";

export type MealType = "breakfast" | "lunch" | "dinner";

export interface MealBooking {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
  dietariesTags: string[] | null;
  /** Root booking id of this stay's split lineage — see bookings.splitGroupId. Null for a never-split booking. */
  splitGroupId: number | null;
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
 *
 * A split (room change mid-stay, see bookings.splitGroupId) chops one real
 * stay into two back-to-back booking rows whose shared boundary date is
 * NOT a real arrival/departure — the guest never actually left. Breakfast
 * and dinner both still land correctly on exactly one of the two halves
 * (the departing half keeps breakfast via its date <= departure, the
 * arriving half keeps dinner via its arrival <= date), but lunch's stricter
 * "neither edge" rule excludes the boundary date from BOTH halves, so a
 * guest handed off between rooms over lunch silently drops off the sheet.
 * We patch that one gap by crediting the boundary lunch to the departing
 * half whenever a same-lineage sibling picks up right where it left off.
 */
export function guestsForMeal(bookings: MealBooking[], date: ISODate, meal: MealType): MealBooking[] {
  return bookings.filter((b) => {
    if (meal === "dinner") return b.arrivalDate <= date && date < b.departureDate;
    if (meal === "breakfast") return b.arrivalDate < date && date <= b.departureDate;
    if (b.arrivalDate < date && date < b.departureDate) return true;
    if (date !== b.departureDate) return false;
    const groupId = b.splitGroupId ?? b.id;
    return bookings.some((o) => o.id !== b.id && (o.splitGroupId ?? o.id) === groupId && o.arrivalDate === date);
  });
}

/** Tag -> count and the guest names behind it, across a set of bookings' own dietariesTags arrays. */
export function aggregateDietaryTags(bookings: MealBooking[]): Array<{ tag: string; count: number; guestNames: string[] }> {
  const names = new Map<string, string[]>();
  for (const b of bookings) {
    for (const tag of b.dietariesTags ?? []) {
      if (!names.has(tag)) names.set(tag, []);
      names.get(tag)!.push(b.guestName);
    }
  }
  return Array.from(names.entries())
    .map(([tag, guestNames]) => ({ tag, count: guestNames.length, guestNames }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
