import { db } from "@/db";
import { desc } from "drizzle-orm";
import { bookings } from "@/db/schema";
import { formatDateUk } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const rows = await db.select().from(bookings).orderBy(desc(bookings.arrivalDate)).limit(200);

  return (
    <div>
      <div className="tr-shell">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>Bookings</h1>
          <span style={{ flex: 1 }} />
          <a href="/bookings/new"><button className="primary">New booking</button></a>
        </div>

        <div className="tr-card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Guest</th>
                <th>Arrival</th>
                <th>Departure</th>
                <th>Group</th>
                <th>Dietary</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const tags = Array.isArray(b.dietariesTags) ? (b.dietariesTags as string[]) : [];
                return (
                  <tr key={b.id} className="tr-row-link">
                    <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.guestName}</a></td>
                    <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{formatDateUk(b.arrivalDate)}</a></td>
                    <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{formatDateUk(b.departureDate)}</a></td>
                    <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.groupId ?? "—"}</a></td>
                    <td title={tags.join(", ")}>
                      <a className="tr-cell-link" href={`/bookings/${b.id}`}>{tags.length > 0 ? tags.join(", ") : "—"}</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
