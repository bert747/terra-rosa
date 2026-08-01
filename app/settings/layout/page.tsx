"use client";

import { useEffect, useState } from "react";
import ToastStack, { type ToastMessage } from "@/components/ToastStack";

const ADD_CUSTOM_TYPE = "__add_custom__";

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

interface AddBedState {
  selected: string;
  custom: string;
  startDate: string;
}

interface JoinedPair {
  id: number;
  bed1Id: number;
  bed2Id: number;
  startDate: string;
  endDate: string | null;
  mode: "double" | "solo";
}

interface JoinPickState {
  bedAId: string;
  bedBId: string;
  mode: "double" | "solo";
  startDate: string;
  endDate: string;
}

export default function PropertyLayoutPage() {
  const [floors, setFloors] = useState<Floor[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [joins, setJoins] = useState<JoinedPair[]>([]);
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
  const [addBedState, setAddBedState] = useState<Record<number, AddBedState>>({});
  const [joinPickState, setJoinPickState] = useState<Record<number, JoinPickState>>({});
  const [addingFloor, setAddingFloor] = useState(false);
  const [newFloorName, setNewFloorName] = useState("");

  async function load() {
    const [f, r, b, j] = await Promise.all([
      fetch("/api/floors").then((res) => res.json()),
      fetch("/api/rooms").then((res) => res.json()),
      fetch("/api/beds").then((res) => res.json()),
      fetch("/api/joined-beds").then((res) => res.json()),
    ]);
    setFloors(f);
    setRooms(r);
    setBeds(b);
    setJoins(j);
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

  // --- Beds --------------------------------------------------------------

  const bedTypes = Array.from(new Set(beds.map((b) => b.type))).sort((a, b) => a.localeCompare(b));

  function getAddBedState(roomId: number): AddBedState {
    return addBedState[roomId] ?? { selected: "", custom: "", startDate: todayISO() };
  }

  function setAddBedField(roomId: number, patch: Partial<AddBedState>) {
    setAddBedState((prev) => ({ ...prev, [roomId]: { ...getAddBedState(roomId), ...patch } }));
  }

  async function submitNewBed(e: React.FormEvent, roomId: number) {
    e.preventDefault();
    const state = getAddBedState(roomId);
    const type = state.selected === ADD_CUSTOM_TYPE ? state.custom.trim() : state.selected;
    if (!type) return;

    const created = await fetch("/api/beds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
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
      setAddBedState((prev) => ({ ...prev, [roomId]: { selected: "", custom: "", startDate: todayISO() } }));
      load();
    }
  }

  async function deleteBed(bed: Bed) {
    if (!window.confirm(`Remove this ${bed.type} bed? Any booking on it will become unassigned.`)) return;
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

  // --- Bed joining ---------------------------------------------------------

  const joinedBedIds = new Set(joins.flatMap((j) => [j.bed1Id, j.bed2Id]));

  function defaultJoinPick(): JoinPickState {
    return { bedAId: "", bedBId: "", mode: "double", startDate: todayISO(), endDate: "" };
  }

  async function joinBeds(bed1Id: number, bed2Id: number, mode: "double" | "solo", startDate: string, endDate: string) {
    setError(null);
    const res = await fetch("/api/joined-beds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bed1Id, bed2Id, mode, startDate: startDate || todayISO(), endDate: endDate || null }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    const body = await res.json();
    notifyUnassigned(body.unassignedBookings);
    load();
  }

  function setJoinPick(roomId: number, patch: Partial<JoinPickState>) {
    setJoinPickState((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? defaultJoinPick()), ...patch } }));
  }

  async function submitJoinPick(e: React.FormEvent, roomId: number, exactPair: [number, number] | null) {
    e.preventDefault();
    const pick = joinPickState[roomId] ?? defaultJoinPick();
    const bed1Id = exactPair ? exactPair[0] : Number(pick.bedAId);
    const bed2Id = exactPair ? exactPair[1] : Number(pick.bedBId);
    if (!bed1Id || !bed2Id || bed1Id === bed2Id) return;
    await joinBeds(bed1Id, bed2Id, pick.mode, pick.startDate, pick.endDate);
    setJoinPickState((prev) => ({ ...prev, [roomId]: defaultJoinPick() }));
  }

  async function splitJoin(join: JoinedPair) {
    if (!window.confirm("Split this joined double back into two single beds, effective today?")) return;
    const ok = await withError(() => fetch(`/api/joined-beds/${join.id}`, { method: "PATCH" }));
    if (ok) load();
  }

  return (
    <div className="tr-shell">
      <h1 style={{ fontSize: 18, margin: "0 0 12px" }}>Property Layout</h1>
      <p className="tr-muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>
        Physical layout is independent of bookings: beds can be added, removed, or placed in any room, whether or
        not anyone is currently booked into them.
      </p>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      {floors.length === 0 && (
        <p className="tr-muted" style={{ marginBottom: 12 }}>No floors yet — add one below to get started.</p>
      )}

      {floors.map((floor) => {
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

                {floorRooms.map((room) => {
                  const roomBeds = beds.filter((bed) => bed.room?.roomId === room.id);
                  const addState = getAddBedState(room.id);

                  const roomBedIds = new Set(roomBeds.map((bed) => bed.id));
                  const roomJoins = joins.filter(
                    (j) => roomBedIds.has(j.bed1Id) && roomBedIds.has(j.bed2Id)
                  );
                  const partnerOf = new Map<number, number>();
                  const joinIdByBed = new Map<number, number>();
                  for (const j of roomJoins) {
                    partnerOf.set(j.bed1Id, j.bed2Id);
                    partnerOf.set(j.bed2Id, j.bed1Id);
                    joinIdByBed.set(j.bed1Id, j.id);
                    joinIdByBed.set(j.bed2Id, j.id);
                  }

                  const unjoinedSingles = roomBeds.filter(
                    (bed) => bed.type.toLowerCase() === "single" && !joinedBedIds.has(bed.id)
                  );
                  const pick = joinPickState[room.id] ?? defaultJoinPick();

                  const visited = new Set<number>();
                  const bedRows: React.ReactNode[] = [];
                  for (const bed of roomBeds) {
                    if (visited.has(bed.id)) continue;
                    const partnerId = partnerOf.get(bed.id);
                    const partner = partnerId != null ? roomBeds.find((b) => b.id === partnerId) : undefined;

                    if (partner) {
                      visited.add(bed.id);
                      visited.add(partner.id);
                      const joinId = joinIdByBed.get(bed.id)!;
                      const joinInfo = joins.find((j) => j.id === joinId)!;
                      const modeLabel = joinInfo.mode === "solo" ? "Solo Double (sleeps 1)" : "Double (sleeps 2)";
                      const dateLabel =
                        joinInfo.startDate > todayISO()
                          ? ` — starts ${joinInfo.startDate}`
                          : joinInfo.endDate
                            ? ` — until ${joinInfo.endDate}`
                            : "";
                      bedRows.push(
                        <li
                          key={`join-${joinId}`}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}
                        >
                          <span style={{ flex: 1 }}>
                            {modeLabel} (2 Single beds){dateLabel}
                          </span>
                          <button type="button" onClick={() => splitJoin({ id: joinId, bed1Id: bed.id, bed2Id: partner.id, startDate: joinInfo.startDate, endDate: joinInfo.endDate, mode: joinInfo.mode })}>
                            Split
                          </button>
                        </li>
                      );
                      continue;
                    }

                    visited.add(bed.id);
                    bedRows.push(
                      <li
                        key={bed.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 }}
                      >
                        <span style={{ flex: 1 }}>{bed.type}</span>
                        <button type="button" className="tr-danger" onClick={() => deleteBed(bed)}>
                          Remove
                        </button>
                      </li>
                    );
                  }

                  return (
                    <div
                      key={room.id}
                      style={{ borderTop: "1px solid var(--tr-border)", padding: "10px 0" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

                      <div style={{ marginTop: 8, marginLeft: 12 }}>
                        {bedRows.length === 0 ? (
                          <p className="tr-muted" style={{ fontSize: 13, margin: "0 0 8px" }}>No beds in this room yet.</p>
                        ) : (
                          <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }}>{bedRows}</ul>
                        )}

                        <form onSubmit={(e) => submitNewBed(e, room.id)} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: unjoinedSingles.length >= 2 ? 8 : 0 }}>
                          <select
                            value={addState.selected}
                            onChange={(e) => setAddBedField(room.id, { selected: e.target.value })}
                          >
                            <option value="">— select bed type —</option>
                            {bedTypes.map((type) => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                            <option value={ADD_CUSTOM_TYPE}>Add new type...</option>
                          </select>
                          {addState.selected === ADD_CUSTOM_TYPE && (
                            <input
                              autoFocus
                              value={addState.custom}
                              onChange={(e) => setAddBedField(room.id, { custom: e.target.value })}
                              placeholder="New bed type"
                              style={{ width: 160 }}
                            />
                          )}
                          <label className="tr-muted" style={{ fontSize: 12 }}>
                            Starting{" "}
                            <input
                              type="date"
                              value={addState.startDate}
                              onChange={(e) => setAddBedField(room.id, { startDate: e.target.value })}
                            />
                          </label>
                          <button type="submit" className="primary">Add Bed</button>
                        </form>

                        {unjoinedSingles.length >= 2 && (
                          <form
                            onSubmit={(e) =>
                              submitJoinPick(
                                e,
                                room.id,
                                unjoinedSingles.length === 2 ? [unjoinedSingles[0].id, unjoinedSingles[1].id] : null
                              )
                            }
                            style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
                          >
                            <span className="tr-muted" style={{ fontSize: 12 }}>Join:</span>
                            {unjoinedSingles.length > 2 && (
                              <>
                                <select value={pick.bedAId} onChange={(e) => setJoinPick(room.id, { bedAId: e.target.value })}>
                                  <option value="">— Single A —</option>
                                  {unjoinedSingles.map((bed, i) => (
                                    <option key={bed.id} value={bed.id} disabled={String(bed.id) === pick.bedBId}>
                                      Single {i + 1}
                                    </option>
                                  ))}
                                </select>
                                <select value={pick.bedBId} onChange={(e) => setJoinPick(room.id, { bedBId: e.target.value })}>
                                  <option value="">— Single B —</option>
                                  {unjoinedSingles.map((bed, i) => (
                                    <option key={bed.id} value={bed.id} disabled={String(bed.id) === pick.bedAId}>
                                      Single {i + 1}
                                    </option>
                                  ))}
                                </select>
                              </>
                            )}
                            <select value={pick.mode} onChange={(e) => setJoinPick(room.id, { mode: e.target.value as "double" | "solo" })}>
                              <option value="double">Double (sleeps 2)</option>
                              <option value="solo">Solo Double (sleeps 1)</option>
                            </select>
                            <label className="tr-muted" style={{ fontSize: 12 }}>
                              From{" "}
                              <input type="date" value={pick.startDate} onChange={(e) => setJoinPick(room.id, { startDate: e.target.value })} />
                            </label>
                            <label className="tr-muted" style={{ fontSize: 12 }}>
                              Until (optional){" "}
                              <input type="date" value={pick.endDate} onChange={(e) => setJoinPick(room.id, { endDate: e.target.value })} />
                            </label>
                            <button type="submit" className="primary">
                              Join as Double
                            </button>
                          </form>
                        )}
                      </div>
                    </div>
                  );
                })}

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

      <div className="tr-card">
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

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
