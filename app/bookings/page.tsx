import { db } from "@/db";
import { desc } from "drizzle-orm";
import { beds, bedLocations, bedSoloPeriods, bookings, joinedBeds, rooms } from "@/db/schema";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import BookingsTable, { type BookingRow } from "@/components/BookingsTable";

export const dynamic = "force-dynamic";

const GUEST_TYPE_LABELS: Record<string, string> = {
  resident: "Resident",
  ashrami: "Ashrami",
  guest: "Guest",
};

export default async function BookingsPage() {
  const [rows, locationRows, roomRows, bedRows, joinRows, soloRows] = await Promise.all([
    db.select().from(bookings).orderBy(desc(bookings.arrivalDate)).limit(200),
    db.select().from(bedLocations),
    db.select().from(rooms),
    db.select().from(beds),
    db.select().from(joinedBeds),
    db.select().from(bedSoloPeriods),
  ]);
  const guestNameById = new Map(rows.map((b) => [b.id, b.guestName]));
  const roomNameById = new Map(roomRows.map((r) => [r.id, r.name]));
  const bedById = new Map(bedRows.map((b) => [b.id, b]));

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

  const tableRows: BookingRow[] = rows.map((b) => {
    const tags = Array.isArray(b.dietariesTags) ? (b.dietariesTags as string[]) : [];
    return {
      id: b.id,
      guestName: b.guestName,
      roomName: roomNameForBooking(b.bedId, b.arrivalDate),
      arrivalDate: formatDateUk(b.arrivalDate),
      departureDate: formatDateUk(b.departureDate),
      stayLength: String(nightsBetween(b.arrivalDate, b.departureDate)),
      sleepsNear: b.linkedBookingId != null ? guestNameById.get(b.linkedBookingId) ?? "—" : "—",
      bedType: bedTypeForBooking(b.bedId, b.arrivalDate),
      guestType: GUEST_TYPE_LABELS[b.guestType] ?? b.guestType,
      dietary: tags.length > 0 ? tags.join(", ") : "—",
    };
  });

  return (
    <div>
      <div className="tr-shell">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>Bookings</h1>
          <span style={{ flex: 1 }} />
          <a href="/bookings/new"><button className="primary">New booking</button></a>
        </div>

        <BookingsTable rows={tableRows} />
      </div>
    </div>
  );
}
