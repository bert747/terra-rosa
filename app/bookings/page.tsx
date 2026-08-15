import { db } from "@/db";
import { desc } from "drizzle-orm";
import { bookings, guestCategories } from "@/db/schema";
import { addDays } from "@/lib/occupancy";
import { computeBookingRows, loadBookingRowContext } from "@/lib/booking-rows";
import BookingsSections from "@/components/BookingsSections";

export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const [rows, ctx, guestCategoryRows] = await Promise.all([
    db.select().from(bookings).orderBy(desc(bookings.arrivalDate)).limit(200),
    loadBookingRowContext(),
    db.select().from(guestCategories),
  ]);

  // "Shares with" groups (see computeBookingRows) need to be resolved across
  // the FULL loaded set before splitting into upcoming/later — a mate could
  // sit on the other side of that split, and computing rows separately per
  // side would miss them.
  const allRows = computeBookingRows(rows, ctx);
  const rowById = new Map(allRows.map((r) => [r.id, r]));

  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = addDays(today, 7);
  const upcoming = rows
    .filter((b) => b.arrivalDate >= today && b.arrivalDate < weekEnd)
    .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
  const upcomingIds = new Set(upcoming.map((b) => b.id));

  const upcomingRows = upcoming.map((b) => rowById.get(b.id)!);
  const laterRows = rows.filter((b) => !upcomingIds.has(b.id)).map((b) => rowById.get(b.id)!);

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
