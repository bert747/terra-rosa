import { db } from "@/db";
import { beds, bedLocations, bedSoloPeriods, bookings, guestCategories, joinedBeds, rooms } from "@/db/schema";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import { type BookingRow } from "@/components/BookingsTable";

type BookingSelect = typeof bookings.$inferSelect;

/**
 * The supporting tables needed to turn a raw `bookings` row into a
 * `BookingRow` — room/bed-type-as-of-arrival, guest category name/colour.
 * These are all small, always-loaded-in-full tables (unlike `bookings`
 * itself, which callers may want a subset of), so loading them is split out
 * from the booking rows themselves and shared between whoever needs to
 * compute BookingRows: the Bookings page's own default (most-recent-200)
 * view, and /api/bookings/search's full-history search.
 */
export interface BookingRowContext {
  locationRows: (typeof bedLocations.$inferSelect)[];
  roomNameById: Map<number, string>;
  bedById: Map<number, typeof beds.$inferSelect>;
  joinRows: (typeof joinedBeds.$inferSelect)[];
  soloRows: (typeof bedSoloPeriods.$inferSelect)[];
  guestCategoryById: Map<number, typeof guestCategories.$inferSelect>;
}

export async function loadBookingRowContext(): Promise<BookingRowContext> {
  const [locationRows, roomRows, bedRows, joinRows, soloRows, guestCategoryRows] = await Promise.all([
    db.select().from(bedLocations),
    db.select().from(rooms),
    db.select().from(beds),
    db.select().from(joinedBeds),
    db.select().from(bedSoloPeriods),
    db.select().from(guestCategories),
  ]);
  return {
    locationRows,
    roomNameById: new Map(roomRows.map((r) => [r.id, r.name])),
    bedById: new Map(bedRows.map((b) => [b.id, b])),
    joinRows,
    soloRows,
    guestCategoryById: new Map(guestCategoryRows.map((c) => [c.id, c])),
  };
}

// "First (Preferred) Last" when a preferred name is set and actually differs
// from the first name — e.g. "Frank (Frabbie) Jones" — otherwise just "First
// Last". Only affects the Bookings table's own Guest column; guestName
// itself (plain "First Last") is untouched everywhere else (grid pill
// tooltips, "Shares with" text, exports, …).
function displayGuestName(b: BookingSelect): string {
  const preferred = b.preferredName?.trim();
  if (preferred && preferred.toLowerCase() !== b.firstName.trim().toLowerCase()) {
    return `${b.firstName} (${preferred}) ${b.lastName}`.trim();
  }
  return `${b.firstName} ${b.lastName}`.trim();
}

/**
 * Turns a set of raw booking rows into `BookingRow`s, given the shared
 * supporting-table context above. "Shares with" groups are computed from
 * WITHIN `bookingRows` only (connected components over linkedBookingId/
 * sharesBedWithBookingId) — a caller that passes a partial set of bookings
 * (e.g. the default page's most-recent-200) may miss a group-mate that fell
 * outside that set, same limitation as before this was extracted.
 */
export function computeBookingRows(bookingRows: BookingSelect[], ctx: BookingRowContext): BookingRow[] {
  const guestNameById = new Map(bookingRows.map((b) => [b.id, b.guestName]));

  // "Shares with" needs to surface the WHOLE group a booking is tied to, not
  // just its own single linkedBookingId/sharesBedWithBookingId pointer —
  // three people can all be tied together (A "sleeps near" B, C "sleeps
  // near" B too) without any one of them pointing directly at each other.
  // Connected components over the undirected graph of those two fields.
  const adjacency = new Map<number, Set<number>>();
  function addEdge(a: number, b: number) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  for (const b of bookingRows) {
    if (b.linkedBookingId != null) addEdge(b.id, b.linkedBookingId);
    if (b.sharesBedWithBookingId != null) addEdge(b.id, b.sharesBedWithBookingId);
  }
  const groupMatesById = new Map<number, number[]>();
  const visited = new Set<number>();
  for (const b of bookingRows) {
    if (visited.has(b.id) || !adjacency.has(b.id)) continue;
    const component: number[] = [];
    const stack = [b.id];
    visited.add(b.id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const next of adjacency.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    for (const id of component) {
      groupMatesById.set(id, component.filter((otherId) => otherId !== id));
    }
  }

  // Which room a booking's bed sat in as of its OWN arrival date — a bed can
  // move rooms over time, so "current room" would be wrong for a past or
  // future stay; the room that mattered for THIS booking is whichever one
  // was active on the day the guest actually checked in.
  function roomNameForBooking(bedId: number | null, arrivalDate: string): string {
    if (bedId == null) return "—";
    const segment = ctx.locationRows.find(
      (l) => l.bedId === bedId && l.startDate <= arrivalDate && (l.endDate == null || l.endDate > arrivalDate)
    );
    if (!segment) return "—";
    return ctx.roomNameById.get(segment.roomId) ?? "—";
  }

  // "Single" / "Couple Double" / "Solo Double" / "1.5 bed" — derived from the
  // bed's own type plus any join/solo-period covering the booking's arrival
  // date, same rule the grid uses to decide how a bed renders.
  function bedTypeForBooking(bedId: number | null, arrivalDate: string): string {
    if (bedId == null) return "—";
    const bed = ctx.bedById.get(bedId);
    if (!bed) return "—";

    if (bed.type.toLowerCase() === "single") {
      const join = ctx.joinRows.find(
        (j) =>
          (j.bed1Id === bedId || j.bed2Id === bedId) &&
          j.startDate <= arrivalDate &&
          (j.endDate == null || j.endDate > arrivalDate)
      );
      if (join) return join.mode === "solo" ? "Solo Double" : "Couple Double";
      return "Single";
    }

    const solo = ctx.soloRows.find(
      (s) => s.bedId === bedId && s.startDate <= arrivalDate && (s.endDate == null || s.endDate > arrivalDate)
    );
    return solo ? "Solo Double" : "1.5 bed";
  }

  return bookingRows.map((b) => {
    const tags = Array.isArray(b.dietariesTags) ? (b.dietariesTags as string[]) : [];
    return {
      id: b.id,
      guestName: displayGuestName(b),
      firstName: b.firstName,
      lastName: b.lastName,
      preferredName: b.preferredName,
      roomName: roomNameForBooking(b.bedId, b.arrivalDate),
      arrivalDate: formatDateUk(b.arrivalDate),
      departureDate: formatDateUk(b.departureDate),
      stayLength: String(nightsBetween(b.arrivalDate, b.departureDate)),
      sharesWith: (() => {
        const mates = groupMatesById.get(b.id) ?? [];
        if (mates.length === 0) return "—";
        return mates
          .map((mateId) => {
            const name = guestNameById.get(mateId) ?? "—";
            return b.sharesBedWithBookingId === mateId ? `${name} (bed)` : name;
          })
          .join(", ");
      })(),
      bedType: bedTypeForBooking(b.bedId, b.arrivalDate),
      guestType: b.guestCategoryId ? ctx.guestCategoryById.get(b.guestCategoryId)?.name ?? "—" : "—",
      guestCategoryColour: b.guestCategoryId ? ctx.guestCategoryById.get(b.guestCategoryId)?.colour ?? null : null,
      dietary: tags.length > 0 ? tags.join(", ") : "—",
    };
  });
}
