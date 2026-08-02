"use client";

import { useEffect, useState } from "react";
import ToastStack, { type ToastMessage } from "@/components/ToastStack";
import DateField from "@/components/DateField";
import { DORM_STORAGE_FLOOR_NAME } from "@/lib/dorm-storage";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Floor {
  id: number;
  name: string;
}

interface Room {
  id: number;
  name: string;
  floorId: number;
}

interface BedPlacement {
  roomId: number;
  roomName: string;
  floorId: number;
  floorName: string;
}

interface Bed {
  id: number;
  type: string;
  room: BedPlacement | null;
}

interface BedType {
  id: number;
  name: string;
  capacity: number;
}

interface AddBedState {
  roomId: string;
  startDate: string;
}

export default function PropertyLayoutPage() {
  const [floors, setFloors] = useState<Floor[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [bedTypes, setBedTypes] = useState<BedType[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  function pushToast(text: string) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function notifyUnassigned(unassignedBookings: Array<{ guestName: string; arrivalDate: string; departureDate: string }> | undefined) {
    if (!unassignedBookings || unassignedBookings.length === 0) return;
    const names = unassignedBookings.map((b) => `${b.guestName} (${b.arrivalDate} to ${b.departureDate})`).join(", ");
    pushToast(
      `This layout change conflicts with ${unassignedBookings.length} existing booking${unassignedBookings.length === 1 ? "" : "s"} — moved to unallocated: ${names}`
    );
  }

  const [collapsedFloorIds, setCollapsedFloorIds] = useState<Set<number>>(new Set());
  const [addingRoomFloorId, setAddingRoomFloorId] = useState<number | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [editingFloorId, setEditingFloorId] = useState<number | null>(null);
  const [floorEditValue, setFloorEditValue] = useState("");
  const [editingRoomId, setEditingRoomId] = useState<number | null>(null);
  const [roomEditValue, setRoomEditValue] = useState("");
  const [addingFloor, setAddingFloor] = useState(false);
  const [newFloorName, setNewFloorName] = useState("");
  const [addBedState, setAddBedState] = useState<Record<number, AddBedState>>({});
  const [addingTypeName, setAddingTypeName] = useState("");
  const [addingTypeCapacity, setAddingTypeCapacity] = useState<1 | 2>(1);
  const [addingType, setAddingType] = useState(false);

  async function load() {
    const [f, r, b, t] = await Promise.all([
      fetch("/api/floors").then((res) => res.json()),
      fetch("/api/rooms").then((res) => res.json()),
      fetch("/api/beds").then((res) => res.json()),
      fetch("/api/bed-types").then((res) => res.json()),
    ]);
    setFloors(f);
    setRooms(r);
    setBeds(b);
    setBedTypes(t);
  }

  useEffect(() => {
    load();
  }, []);

  async function withError(action: () => Promise<Response>) {
    setError(null);
    const res = await action();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return false;
    }
    return true;
  }

  function toggleFloorCollapsed(floorId: number) {
    setCollapsedFloorIds((prev) => {
      const next = new Set(prev);
      if (next.has(floorId)) next.delete(floorId);
      else next.add(floorId);
      return next;
    });
  }

  // --- Floors ---------------------------------------------------------

  async function submitNewFloor(e: React.FormEvent) {
    e.preventDefault();
    if (!newFloorName.trim()) return;
    const ok = await withError(() =>
      fetch("/api/floors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newFloorName.trim() }),
      })
    );
    if (ok) {
      setNewFloorName("");
      setAddingFloor(false);
      load();
    }
  }

  function startEditFloor(floor: Floor) {
    setEditingFloorId(floor.id);
    setFloorEditValue(floor.name);
  }

  async function submitFloorEdit(e: React.FormEvent, floor: Floor) {
    e.preventDefault();
    const name = floorEditValue.trim();
    if (!name || name === floor.name) {
      setEditingFloorId(null);
      return;
    }
    const ok = await withError(() =>
      fetch(`/api/floors/${floor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    );
    setEditingFloorId(null);
    if (ok) load();
  }

  async function deleteFloor(floor: Floor) {
    if (!window.confirm(`Delete floor "${floor.name}"? This also deletes its rooms.`)) return;
    const ok = await withError(() => fetch(`/api/floors/${floor.id}`, { method: "DELETE" }));
    if (ok) load();
  }

  // --- Rooms -----------------------------------------------------------

  function startAddRoom(floorId: number) {
    setAddingRoomFloorId(floorId);
    setNewRoomName("");
  }

  async function submitNewRoom(e: React.FormEvent, floorId: number) {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    const ok = await withError(() =>
      fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newRoomName.trim(), floorId }),
      })
    );
    if (ok) {
      setNewRoomName("");
      setAddingRoomFloorId(null);
      load();
    }
  }

  function startEditRoom(room: Room) {
    setEditingRoomId(room.id);
    setRoomEditValue(room.name);
  }

  async function submitRoomEdit(e: React.FormEvent, room: Room) {
    e.preventDefault();
    const name = roomEditValue.trim();
    if (!name || name === room.name) {
      setEditingRoomId(null);
      return;
    }
    const ok = await withError(() =>
      fetch(`/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    );
    setEditingRoomId(null);
    if (ok) load();
  }

  async function deleteRoom(room: Room) {
    if (!window.confirm(`Delete room "${room.name}"? Beds placed here will become unplaced.`)) return;
    const ok = await withError(() => fetch(`/api/rooms/${room.id}`, { method: "DELETE" }));
    if (ok) load();
  }

  // --- Bed inventory -----------------------------------------------------

  function getAddBedState(typeId: number): AddBedState {
    return addBedState[typeId] ?? { roomId: "", startDate: todayISO() };
  }

  function setAddBedField(typeId: number, patch: Partial<AddBedState>) {
    setAddBedState((prev) => ({ ...prev, [typeId]: { ...getAddBedState(typeId), ...patch } }));
  }

  async function submitNewBed(e: React.FormEvent, type: BedType) {
    e.preventDefault();
    const state = getAddBedState(type.id);
    const roomId = Number(state.roomId);
    if (!roomId) return;

    const created = await fetch("/api/beds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type.name }),
    });
    if (!created.ok) {
      const body = await created.json().catch(() => ({}));
      setError(body.error ?? "Could not create bed.");
      return;
    }
    const bed = await created.json();

    const placed = await withError(() =>
      fetch("/api/bed-locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bedId: bed.id, roomId, startDate: state.startDate || todayISO() }),
      })
    );
    if (placed) {
      setAddBedState((prev) => ({ ...prev, [type.id]: { roomId: "", startDate: todayISO() } }));
      load();
    }
  }

  async function deleteBed(bed: Bed) {
    const where = bed.room ? `in ${bed.room.roomName}` : "(currently unplaced)";
    if (!window.confirm(`Remove this ${bed.type} bed ${where}? Any booking on it will become unassigned.`)) return;
    setError(null);
    const res = await fetch(`/api/beds/${bed.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    const body = await res.json();
    notifyUnassigned(body.unassignedBookings);
    load();
  }

  async function submitNewBedType(e: React.FormEvent) {
    e.preventDefault();
    const name = addingTypeName.trim();
    if (!name) return;
    const ok = await withError(() =>
      fetch("/api/bed-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, capacity: addingTypeCapacity }),
      })
    );
    if (ok) {
      setAddingTypeName("");
      setAddingTypeCapacity(1);
      setAddingType(false);
      load();
    }
  }

  const roomsByFloor = new Map<number, Room[]>();
  for (const room of rooms) {
    const list = roomsByFloor.get(room.floorId) ?? [];
    list.push(room);
    roomsByFloor.set(room.floorId, list);
  }
  const floorNameById = new Map(floors.map((f) => [f.id, f.name]));

  return (
    <div className="tr-shell">
      <h1 style={{ fontSize: 18, margin: "0 0 12px" }}>Property Layout</h1>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      {/* --- Floors & rooms --------------------------------------------- */}
      <p className="tr-muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>
        Floors and rooms are the property&apos;s fixed structure. Where a bed sits, and any solo/couple double
        joins, are day-to-day layout — set those on the Dorm Board grid instead.
      </p>

      {floors.length === 0 && (
        <p className="tr-muted" style={{ marginBottom: 12 }}>No floors yet — add one below to get started.</p>
      )}

      {/* "Storage" holds the system-managed Dorm Storage room (see
          src/lib/dorm-storage.ts) — not part of the user-managed physical
          layout, so it's hidden here rather than editable/deletable. */}
      {floors.filter((floor) => floor.name !== DORM_STORAGE_FLOOR_NAME).map((floor) => {
        const floorRooms = rooms.filter((r) => r.floorId === floor.id);
        const collapsed = collapsedFloorIds.has(floor.id);

        return (
          <div className="tr-card" key={floor.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => toggleFloorCollapsed(floor.id)}
                aria-label={collapsed ? "Expand floor" : "Collapse floor"}
                style={{ fontSize: 12, minWidth: 24 }}
              >
                {collapsed ? "▸" : "▾"}
              </button>

              {editingFloorId === floor.id ? (
                <form onSubmit={(e) => submitFloorEdit(e, floor)} style={{ display: "flex", gap: 6, flex: 1 }}>
                  <input
                    autoFocus
                    value={floorEditValue}
                    onChange={(e) => setFloorEditValue(e.target.value)}
                    style={{ flex: 1, maxWidth: 280 }}
                  />
                  <button type="submit" className="primary">Save</button>
                  <button type="button" onClick={() => setEditingFloorId(null)}>Cancel</button>
                </form>
              ) : (
                <h2 className="tr-section-title" style={{ margin: 0, flex: 1 }}>{floor.name}</h2>
              )}

              {editingFloorId !== floor.id && (
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" onClick={() => startEditFloor(floor)}>Rename</button>
                  <button type="button" className="tr-danger" onClick={() => deleteFloor(floor)}>Delete</button>
                </div>
              )}
            </div>

            {!collapsed && (
              <div style={{ marginTop: 12, paddingLeft: 30 }}>
                {floorRooms.length === 0 && (
                  <p className="tr-muted" style={{ fontSize: 13, marginTop: 0 }}>No rooms on this floor yet.</p>
                )}

                {floorRooms.map((room) => (
                  <div
                    key={room.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--tr-border)", padding: "8px 0" }}
                  >
                    {editingRoomId === room.id ? (
                      <form onSubmit={(e) => submitRoomEdit(e, room)} style={{ display: "flex", gap: 6, flex: 1 }}>
                        <input
                          autoFocus
                          value={roomEditValue}
                          onChange={(e) => setRoomEditValue(e.target.value)}
                          style={{ width: 220 }}
                        />
                        <button type="submit" className="primary">Save</button>
                        <button type="button" onClick={() => setEditingRoomId(null)}>Cancel</button>
                      </form>
                    ) : (
                      <strong style={{ flex: 1 }}>{room.name}</strong>
                    )}

                    {editingRoomId !== room.id && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button type="button" onClick={() => startEditRoom(room)}>Rename</button>
                        <button type="button" className="tr-danger" onClick={() => deleteRoom(room)}>Delete</button>
                      </div>
                    )}
                  </div>
                ))}

                {addingRoomFloorId === floor.id ? (
                  <form
                    onSubmit={(e) => submitNewRoom(e, floor.id)}
                    style={{ display: "flex", gap: 8, marginTop: 10 }}
                  >
                    <input
                      autoFocus
                      value={newRoomName}
                      onChange={(e) => setNewRoomName(e.target.value)}
                      placeholder="Room name"
                      style={{ width: 220 }}
                    />
                    <button type="submit" className="primary">Add</button>
                    <button type="button" onClick={() => setAddingRoomFloorId(null)}>Cancel</button>
                  </form>
                ) : (
                  <button type="button" onClick={() => startAddRoom(floor.id)} style={{ marginTop: 10 }}>
                    + Add Room to this Floor
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="tr-card" style={{ marginBottom: 24 }}>
        {addingFloor ? (
          <form onSubmit={submitNewFloor} style={{ display: "flex", gap: 8 }}>
            <input
              autoFocus
              value={newFloorName}
              onChange={(e) => setNewFloorName(e.target.value)}
              placeholder="Floor name"
              style={{ flex: 1, maxWidth: 280 }}
            />
            <button type="submit" className="primary">Add</button>
            <button type="button" onClick={() => setAddingFloor(false)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="primary" onClick={() => setAddingFloor(true)}>
            + Add Floor
          </button>
        )}
      </div>

      {/* --- Bed inventory ------------------------------------------------ */}
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Bed Inventory</h1>
      <p className="tr-muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>
        Add a bed here when you buy one, remove one when it breaks. Each bed type below lists every bed of that
        type and which room it&apos;s currently in.
      </p>

      {bedTypes.map((type) => {
        const bedsOfType = beds.filter((b) => b.type === type.name);
        const addState = getAddBedState(type.id);

        return (
          <div className="tr-card" key={type.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
              <strong>{type.name}</strong>
              <span className="tr-muted" style={{ fontSize: 12 }}>
                sleeps {type.capacity} · {bedsOfType.length} in inventory
              </span>
            </div>

            {bedsOfType.length === 0 ? (
              <p className="tr-muted" style={{ fontSize: 13, margin: "0 0 8px" }}>None yet.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }}>
                {bedsOfType.map((bed) => (
                  <li key={bed.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}>
                    <span style={{ flex: 1 }}>
                      {bed.room ? `${bed.room.roomName} (${bed.room.floorName})` : <span className="tr-muted">Unplaced</span>}
                    </span>
                    <button type="button" className="tr-danger" onClick={() => deleteBed(bed)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={(e) => submitNewBed(e, type)} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select
                value={addState.roomId}
                onChange={(e) => setAddBedField(type.id, { roomId: e.target.value })}
              >
                <option value="">— which room? —</option>
                {floors.filter((f) => f.name !== DORM_STORAGE_FLOOR_NAME).map((floor) => (
                  <optgroup key={floor.id} label={floorNameById.get(floor.id)}>
                    {(roomsByFloor.get(floor.id) ?? []).map((room) => (
                      <option key={room.id} value={room.id}>{room.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <label className="tr-muted" style={{ fontSize: 12 }}>
                Starting{" "}
                <DateField value={addState.startDate} onChange={(iso) => setAddBedField(type.id, { startDate: iso })} />
              </label>
              <button type="submit" className="primary">Add {type.name}</button>
            </form>
          </div>
        );
      })}

      <div className="tr-card">
        {addingType ? (
          <form onSubmit={submitNewBedType} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              autoFocus
              value={addingTypeName}
              onChange={(e) => setAddingTypeName(e.target.value)}
              placeholder="Bed type name (e.g. Bunk)"
              style={{ width: 220 }}
            />
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="radio"
                name="capacity"
                checked={addingTypeCapacity === 1}
                onChange={() => setAddingTypeCapacity(1)}
              />
              Sleeps 1
            </label>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
              <input
                type="radio"
                name="capacity"
                checked={addingTypeCapacity === 2}
                onChange={() => setAddingTypeCapacity(2)}
              />
              Sleeps 2
            </label>
            <button type="submit" className="primary">Add Bed Type</button>
            <button type="button" onClick={() => setAddingType(false)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="primary" onClick={() => setAddingType(true)}>
            + Add a New Bed Type
          </button>
        )}
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
