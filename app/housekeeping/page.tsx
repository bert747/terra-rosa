"use client";

import { useEffect, useState } from "react";
import { addDays, type ISODate } from "@/lib/occupancy";
import DateField from "@/components/DateField";

function todayIso(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

interface LayoutCheckEntry {
  label: string;
  state: "occupied" | "empty";
  count: number;
}

interface RoomHousekeeping {
  roomName: string;
  moverTasks: string[];
  layoutCheck: LayoutCheckEntry[];
}

export default function HousekeepingDailySheetPage() {
  const [date, setDate] = useState<ISODate>(todayIso);
  const [rooms, setRooms] = useState<RoomHousekeeping[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/housekeeping?date=${date}`)
      .then((r) => r.json())
      .then((body) => setRooms(body.rooms ?? []))
      .finally(() => setLoading(false));
  }, [date]);

  const roomsWithMoves = rooms.filter((r) => r.moverTasks.length > 0);
  const roomsWithLayout = rooms.filter((r) => r.layoutCheck.length > 0);

  return (
    <div className="tr-shell">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <h1 className="tr-page-title" style={{ margin: 0 }}>Housekeeping Daily Sheet</h1>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setDate(addDays(date, -1))}>← Prev day</button>
        <DateField value={date} onChange={(iso) => iso && setDate(iso)} />
        <button type="button" onClick={() => setDate(todayIso())}>Today</button>
        <button type="button" onClick={() => setDate(addDays(date, 1))}>Next day →</button>
      </div>

      {loading && <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>Loading…</p>}

      <div className="tr-card" style={{ marginBottom: 16 }}>
        <h2 className="tr-section-title" style={{ marginBottom: 8 }}>1. Heavy Lifting / Mover&apos;s List</h2>
        {roomsWithMoves.length === 0 && <p className="tr-muted">No bed moves, joins, or splits scheduled today.</p>}
        {roomsWithMoves.map((r) => (
          <div key={r.roomName} style={{ marginBottom: 10 }}>
            <strong>{r.roomName}</strong>
            <ul style={{ margin: "4px 0 0 18px" }}>
              {r.moverTasks.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="tr-card">
        <h2 className="tr-section-title" style={{ marginBottom: 8 }}>2. Room Check — Arrivals &amp; Changes</h2>
        <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 10 }}>
          Beds are made up on arrival day. Rooms below have a guest arriving today, or a layout change (move/join/split) —
          everything else is unchanged from yesterday.
        </p>
        {roomsWithLayout.length === 0 && <p className="tr-muted">No arrivals or changes today.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {roomsWithLayout.map((r) => (
            <div key={r.roomName}>
              <strong style={{ display: "block", marginBottom: 4 }}>{r.roomName}</strong>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {r.layoutCheck.map((entry, i) => (
                  <span
                    key={i}
                    className="tr-badge"
                    style={{
                      background: entry.state === "occupied" ? "var(--tr-accent-soft)" : "var(--tr-muted-bg, #eee)",
                      fontWeight: entry.state === "occupied" ? 600 : 400,
                    }}
                  >
                    {entry.count} {entry.label} — {entry.state}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
