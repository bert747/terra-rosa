"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface RoomRow {
  id: number;
  name: string;
  locationOrType: string | null;
  defaultBedCount: number;
  isActive: boolean;
  notes: string | null;
}

export default function RoomDetailPage() {
  const params = useParams<{ id: string }>();
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [form, setForm] = useState({ name: "", locationOrType: "", defaultBedCount: 1, notes: "" });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const roomData = await fetch(`/api/rooms/${params.id}`).then((res) => res.json());
    setRoom(roomData);
    setForm({
      name: roomData.name ?? "",
      locationOrType: roomData.locationOrType ?? "",
      defaultBedCount: roomData.defaultBedCount ?? 1,
      notes: roomData.notes ?? "",
    });
  }

  useEffect(() => {
    if (params.id) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`/api/rooms/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        locationOrType: form.locationOrType,
        defaultBedCount: Number(form.defaultBedCount),
        notes: form.notes,
      }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not save room.");
      return;
    }
    load();
  }

  if (!room) return <div className="tr-shell">Loading…</div>;

  return (
    <div className="tr-shell">
      <a href="/rooms">← Back to rooms</a>
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>{room.name}</h1>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card" style={{ maxWidth: 560 }}>
        <form onSubmit={save} style={{ display: "grid", gap: 8 }}>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Location / type</label>
            <input value={form.locationOrType} onChange={(e) => setForm({ ...form, locationOrType: e.target.value })} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Default beds</label>
            <input type="number" min={0} value={form.defaultBedCount} onChange={(e) => setForm({ ...form, defaultBedCount: Number(e.target.value) })} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: 12 }}>Notes</label>
            <textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="submit" className="primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
