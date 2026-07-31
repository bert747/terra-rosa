"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface EventRow {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  notes: string | null;
}

export default function EventsPage() {
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", startDate: "", endDate: "", notes: "" });
  const [editingId, setEditingId] = useState<number | null>(null);

  async function load() {
    const rows = (await fetch("/api/events").then((r) => r.json())) as EventRow[];
    setEvents(rows);

    const editIdRaw = searchParams.get("edit");
    if (!editIdRaw) return;
    const editId = Number(editIdRaw);
    if (!Number.isInteger(editId) || editId < 1) return;

    const target = rows.find((row) => row.id === editId);
    if (!target) return;
    setEditingId(target.id);
    setForm({
      name: target.name,
      startDate: target.startDate,
      endDate: target.endDate,
      notes: target.notes ?? "",
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function saveEvent(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const method = editingId ? "PATCH" : "POST";
    const path = editingId ? `/api/events/${editingId}` : "/api/events";
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? `Could not ${editingId ? "update" : "add"} event.`);
      return;
    }
    setForm({ name: "", startDate: "", endDate: "", notes: "" });
    setEditingId(null);
    load();
  }

  async function deleteEvent(eventId: number) {
    setError(null);
    if (!window.confirm("Delete this event?")) return;
    const res = await fetch(`/api/events/${eventId}`, { method: "DELETE" });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not delete event.");
      return;
    }
    if (editingId === eventId) {
      setEditingId(null);
      setForm({ name: "", startDate: "", endDate: "", notes: "" });
    }
    load();
  }

  function beginEdit(ev: EventRow) {
    setEditingId(ev.id);
    setForm({
      name: ev.name,
      startDate: ev.startDate,
      endDate: ev.endDate,
      notes: ev.notes ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({ name: "", startDate: "", endDate: "", notes: "" });
  }

  return (
    <div className="tr-shell">
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Events / retreat periods</h1>
      <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
        Anything added here shows as a band across the top of the <a href="/grid">grid</a> for the days it covers. The end date is <strong>inclusive</strong> — an event from the 1st to the 7th covers seven days, the last of them the 7th.
      </p>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card">
        <div className="tr-table-wrap">
          <table className="tr-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Start</th>
              <th>End</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id}>
                <td>{ev.name}</td>
                <td>{ev.startDate}</td>
                <td>{ev.endDate}</td>
                <td className="tr-muted tr-cell-clip" title={ev.notes ?? ""}>{ev.notes ?? ""}</td>
                <td className="tr-col-actions">
                  <button type="button" onClick={() => beginEdit(ev)}>
                    Edit
                  </button>
                  <button type="button" className="tr-danger" onClick={() => deleteEvent(ev.id)} style={{ marginLeft: 6 }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </div>

      <div className="tr-card">
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>{editingId ? `Edit event #${editingId}` : "Add event"}</h2>
        <form onSubmit={saveEvent} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Start</label>
            <input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>End</label>
            <input type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </div>
          <div style={{ minWidth: 260, flex: "1 1 260px" }}>
            <label style={{ display: "block", fontSize: 12 }}>Notes</label>
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="submit" className="primary">
            {editingId ? "Save event" : "Add event"}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
