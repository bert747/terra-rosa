import { getCurrentUser, hasHousekeepingPinCookie } from "@/lib/auth";
import { housekeepingForDate } from "@/lib/housekeeping";

export const dynamic = "force-dynamic";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async function HousekeepingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const params = await searchParams;
  const [user, pinCookie] = await Promise.all([getCurrentUser(), hasHousekeepingPinCookie()]);
  const unlocked = Boolean(user) || pinCookie;

  if (!unlocked) {
    return (
      <div className="tr-shell" style={{ maxWidth: 360, marginTop: 60 }}>
        <div className="tr-card">
          <h1 style={{ fontSize: 18, marginBottom: 12 }}>Housekeeping</h1>
          {params.error && (
            <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>
              Incorrect PIN.
            </p>
          )}
          <form action="/api/housekeeping/pin" method="post">
            <label style={{ display: "block", marginBottom: 4 }}>Enter PIN</label>
            <input
              type="tel"
              name="pin"
              inputMode="numeric"
              autoFocus
              required
              style={{ width: "100%", fontSize: 20, textAlign: "center", marginBottom: 12 }}
            />
            <button type="submit" className="primary" style={{ width: "100%" }}>
              Unlock
            </button>
          </form>
        </div>
      </div>
    );
  }

  const date = params.date ?? todayISO();
  const entries = await housekeepingForDate(date);
  const actionable = entries.filter((entry) =>
    entry.status === "arrival" ||
    entry.status === "departure" ||
    Boolean(entry.bedInstruction) ||
    entry.notes.length > 0
  );
  const prev = addDays(date, -1);
  const next = addDays(date, 1);

  return (
    <div className="tr-shell" style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <a href={`/housekeeping?date=${prev}`}><button>&larr;</button></a>
        <form method="get" action="/housekeeping" style={{ margin: 0, flex: 1 }}>
          <input
            type="date"
            name="date"
            defaultValue={date}
            aria-label="Jump to date"
            style={{ width: "100%", textAlign: "center", fontSize: 16 }}
          />
        </form>
        <a href={`/housekeeping?date=${next}`}><button>&rarr;</button></a>
      </div>

      {actionable.length === 0 && (
        <div className="tr-card">
          <strong>No housekeeping actions for this date.</strong>
          <p className="tr-muted" style={{ marginBottom: 0 }}>
            No arrivals, departures, bed setup changes, or room notes were found.
          </p>
        </div>
      )}

      {actionable.map((entry) => (
        <div key={entry.roomId} className="tr-card">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 15 }}>{entry.roomName}</strong>
            {entry.locationOrType && <span className="tr-muted">({entry.locationOrType})</span>}
          </div>
          {entry.status !== "arrival" && entry.bedInstruction && (
            <p style={{ marginTop: 6, fontWeight: 600 }}>
              {entry.status === "departure" ? "Put beds away after departure: " : ""}
              {entry.bedInstruction}
            </p>
          )}
          {entry.notes.length > 0 && (
            <ul style={{ marginTop: 6 }}>
              {entry.notes.map((n, i) => (
                <li key={i} className="tr-muted">
                  {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      <p className="tr-muted" style={{ fontSize: 12, textAlign: "center" }}>
        Read-only view — for changes, ask an editor to update bookings or rooms.
      </p>
    </div>
  );
}
