import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { arrivals, departures, mealCountsForDate, propertyOccupancy, roomStatusesForDate } from "@/lib/occupancy";

export const dynamic = "force-dynamic";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function DashboardPage() {
  try {
    await requireUser();
  } catch {
    redirect("/login");
  }

  const date = todayISO();
  const [occupancy, arr, dep, meals, roomStatuses] = await Promise.all([
    propertyOccupancy(date),
    arrivals(date),
    departures(date),
    mealCountsForDate(date),
    roomStatusesForDate(date),
  ]);

  const conflicts = roomStatuses.filter((r) => r.isOverCapacity);

  return (
    <div className="tr-shell">
        <h1 style={{ fontSize: 18, margin: "8px 0 16px" }}>Dashboard — {date}</h1>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <div className="tr-card">
            <div className="tr-muted">In-house tonight</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{occupancy}</div>
          </div>
          <div className="tr-card">
            <div className="tr-muted">Arrivals today</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{arr}</div>
          </div>
          <div className="tr-card">
            <div className="tr-muted">Departures today</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{dep}</div>
          </div>
          <div className="tr-card">
            <div className="tr-muted">Capacity conflicts</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: conflicts.length ? "#8a2c2c" : undefined }}>
              {conflicts.length}
            </div>
          </div>
        </div>

        <div className="tr-card">
          <h2 style={{ fontSize: 15, marginBottom: 8 }}>Meal counts today</h2>
          <div className="tr-table-wrap">
            <table className="tr-table">
              <thead>
                <tr>
                  <th>Breakfast</th>
                  <th>Lunch</th>
                  <th>Dinner</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{meals.breakfast}</td>
                  <td>{meals.lunch}</td>
                  <td>{meals.dinner}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {conflicts.length > 0 && (
          <div className="tr-card">
            <h2 style={{ fontSize: 15, marginBottom: 8 }}>Rooms over capacity</h2>
            <ul>
              {conflicts.map((c) => (
                <li key={c.roomId}>
                  Room #{c.roomId}: {c.occupancy} guests in a {c.capacity}-bed room
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="tr-muted" style={{ fontSize: 13 }}>
          See the <a href="/grid">grid view</a> for a multi-day breakdown, or{" "}
          <a href="/bookings">bookings</a> to add arrivals.
        </p>
    </div>
  );
}
