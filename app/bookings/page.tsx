import { db } from "@/db";
import { desc } from "drizzle-orm";
import { beds, bedLocations, bedSoloPeriods, bookings, guestCategories, joinedBeds, rooms } from "@/db/schema";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import { addDays } from "@/lib/occupancy";
import { type BookingRow } from "@/components/BookingsTable";
import BookingsSections from "@/components/BookingsSections";

export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const [rows, locationRows, roomRows, bedRows, joinRows, soloRows, guestCategoryRows] = await Promise.all([
    db.select().from(bookings).orderBy(desc(bookings.arrivalDate)).limit(200),
    db.select().from(bedLocations),
    db.select().from(rooms),
    db.select().from(beds),
    db.select().from(joinedBeds),
    db.select().from(bedSoloPeriods),
    db.select().from(guestCategories),
  ]);
  const guestNameById = new Map(rows.map((b) => [b.id, b.guestName]));
  const roomNameById = new Map(roomRows.map((r) => [r.id, r.name]));
  const bedById = new Map(bedRows.map((b) => [b.id, b]));
  const guestCategoryById = new Map(guestCategoryRows.map((c) => [c.id, c]));

  // "Shares with" needs to surface the WHOLE group a booking is tied to,
  // not just its own single linkedBookingId/sharesBedWithBookingId pointer
  // — three people can all be tied together (A "sleeps near" B, C "sleeps
  // near" B too) without any one of them pointing directly at each other.
  // Connected components over the undirected graph of those two fields.
  const adjacency = new Map<number, Set<number>>();
  function addEdge(a: number, b: number) {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  for (const b of rows) {
    if (b.linkedBookingId != null) addEdge(b.id, b.linkedBookingId);
    if (b.sharesBedWithBookingId != null) addEdge(b.id, b.sharesBedWithBookingId);
  }
  const groupMatesById = new Map<number, number[]>();
  const visited = new Set<number>();
  for (const b of rows) {
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

  // Which room a booking's bed sat in as of its OWN arrival date — a bed
  // can move rooms over time, so "current room" would be wrong for a past
  // or future stay; the room that mattered for THIS booking is whichever
  // one was active on the day the guest actually checked in.
  function roomNameForBooking(bedId: number | null, arrivalDate: string): string {
    if (bedId == null) return "—";
    const segment = locationRows.find(
      (l) => l.bedId === bedId && l.startDate <= arrivalDate && (l.endDate == null || l.endDate > arrivalDate)
    );
    if (!segment) return "—";
    return roomNameById.get(segment.roomId) ?? "—";
  }

  // "Single" / "Couple Double" / "Solo Double" / "1.5 bed" — derived from
  // the bed's own type plus any join/solo-period covering the booking's
  // arrival date, same rule the grid uses to decide how a bed renders.
  function bedTypeForBooking(bedId: number | null, arrivalDate: string): string {
    if (bedId == null) return "—";
    const bed = bedById.get(bedId);
    if (!bed) return "—";

    if (bed.type.toLowerCase() === "single") {
      const join = joinRows.find(
        (j) =>
          (j.bed1Id === bedId || j.bed2Id === bedId) &&
          j.startDate <= arrivalDate &&
          (j.endDate == null || j.endDate > arrivalDate)
      );
      if (join) return join.mode === "solo" ? "Solo Double" : "Couple Double";
      return "Single";
    }

    const solo = soloRows.find(
      (s) => s.bedId === bedId && s.startDate <= arrivalDate && (s.endDate == null || s.endDate > arrivalDate)
    );
    return solo ? "Solo Double" : "1.5 bed";
  }

  // "First (Preferred) Last" when a preferred name is set and actually
  // differs from the first name — e.g. "Frank (Frabbie) Jones" — otherwise
  // just "First Last". Only affects the Bookings table's own Guest column;
  // b.guestName itself (plain "First Last") is untouched everywhere else
  // (grid pill tooltips, "Shares with" text, exports, …).
  function displayGuestName(b: (typeof rows)[number]): string {
    const preferred = b.preferredName?.trim();
    if (preferred && preferred.toLowerCase() !== b.firstName.trim().toLowerCase()) {
      return `${b.firstName} (${preferred}) ${b.lastName}`.trim();
    }
    return `${b.firstName} ${b.lastName}`.trim();
  }

  function toRow(b: (typeof rows)[number]): BookingRow {
    const tags = Array.isArray(b.dietariesTags) ? (b.dietariesTags as string[]) : [];
    return {
      id: b.id,
      guestName: displayGuestName(b),
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
      guestType: b.guestCategoryId ? guestCategoryById.get(b.guestCategoryId)?.name ?? "—" : "—",
      guestCategoryColour: b.guestCategoryId ? guestCategoryById.get(b.guestCategoryId)?.colour ?? null : null,
      dietary: tags.length > 0 ? tags.join(", ") : "—",
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = addDays(today, 7);
  const upcoming = rows
    .filter((b) => b.arrivalDate >= today && b.arrivalDate < weekEnd)
    .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
  const upcomingIds = new Set(upcoming.map((b) => b.id));
  const later = rows.filter((b) => !upcomingIds.has(b.id));

  const upcomingRows = upcoming.map(toRow);
  const laterRows = later.map(toRow);

  return (
    <div>
      <div className="tr-shell">
        <BookingsSections
          sections={[
            { title: "Arriving in the next 7 days", rows: upcomingRows, emptyMessage: "No arrivals in the next 7 days." },
            { title: "Other bookings", rows: laterRows },
          ]}
          guestCategories={guestCategoryRows.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name, colour: c.colour }))}
        />
      </div>
    </div>
  );
}
