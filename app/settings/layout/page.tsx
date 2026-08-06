"use client";

import { useEffect, useRef, useState } from "react";
import ToastStack, { type ToastMessage } from "@/components/ToastStack";
import DateField from "@/components/DateField";
import HelpButton from "@/components/HelpButton";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import { DORM_STORAGE_FLOOR_NAME } from "@/lib/dorm-storage";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

const COLLAPSED_FLOORS_KEY = "tr-layout-collapsed-floors";

interface Floor {
  id: number;
  name: string;
}

interface Room {
  id: number;
  name: string;
  floorId: number;
  categoryId: number | null;
  excludeFromSuggestions: boolean;
}

interface RoomCategory {
  id: number;
  name: string;
  rank: number;
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
  const [categories, setCategories] = useState<RoomCategory[]>([]);
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
  const [editMode, setEditMode] = useState(false);
  const [bedEditMode, setBedEditMode] = useState(false);
  const [addingTypeIdForAdd, setAddingTypeIdForAdd] = useState<number | null>(null);
  const [removingTypeId, setRemovingTypeId] = useState<number | null>(null);
  const [removeBedChoice, setRemoveBedChoice] = useState("");
  const [addingRoomFloorId, setAddingRoomFloorId] = useState<number | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [editingFloorId, setEditingFloorId] = useState<number | null>(null);
  const [floorEditValue, setFloorEditValue] = useState("");
  const [editingRoomId, setEditingRoomId] = useState<number | null>(null);
  const [roomEditValue, setRoomEditValue] = useState("");
  const [movingRoomId, setMovingRoomId] = useState<number | null>(null);
  const [moveTargetFloorId, setMoveTargetFloorId] = useState("");
  const [confirmState, setConfirmState] = useState<ConfirmModalState | null>(null);
  const [addingFloor, setAddingFloor] = useState(false);
  const [newFloorName, setNewFloorName] = useState("");
  const [addBedState, setAddBedState] = useState<Record<number, AddBedState>>({});
  const [addingTypeName, setAddingTypeName] = useState("");
  const [addingTypeCapacity, setAddingTypeCapacity] = useState<1 | 2>(1);
  const [addingType, setAddingType] = useState(false);

  async function load() {
    const [f, r, b, t, c] = await Promise.all([
      fetch("/api/floors").then((res) => res.json()),
      fetch("/api/rooms").then((res) => res.json()),
      fetch("/api/beds").then((res) => res.json()),
      fetch("/api/bed-types").then((res) => res.json()),
      fetch("/api/room-categories").then((res) => res.json()),
    ]);
    setFloors(f);
    setRooms(r);
    setBeds(b);
    setBedTypes(t);
    setCategories(c);
  }

  useEffect(() => {
    load();
  }, []);

  // Floors (with their rooms/beds inside) start COLLAPSED — this page is
  // mostly used to check/tweak one specific floor, not read the whole
  // building top to bottom, so a big wall of expanded rooms on every visit
  // was mostly scrolling past stuff you didn't come here for. Once you
  // manually expand/collapse anything, that choice sticks via
  // sessionStorage — cleared when the tab/browser actually closes (a
  // genuine "for this session" preference, not a permanent one) rather
  // than persisting forever like the grid's own display settings do.
  const collapseInitRef = useRef(false);
  useEffect(() => {
    if (collapseInitRef.current || floors.length === 0) return;
    collapseInitRef.current = true;
    try {
      const stored = sessionStorage.getItem(COLLAPSED_FLOORS_KEY);
      if (stored) {
        setCollapsedFloorIds(new Set(JSON.parse(stored)));
        return;
      }
    } catch {
      // Corrupt/foreign value — fall through to the default below.
    }
    setCollapsedFloorIds(new Set(floors.map((f) => f.id)));
  }, [floors]);

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

  function persistCollapsedFloors(next: Set<number>) {
    setCollapsedFloorIds(next);
    try {
      sessionStorage.setItem(COLLAPSED_FLOORS_KEY, JSON.stringify([...next]));
    } catch {
      // Storage unavailable — collapsing still works for this render, it
      // just won't survive a navigation.
    }
  }

  function toggleFloorCollapsed(floorId: number) {
    const next = new Set(collapsedFloorIds);
    if (next.has(floorId)) next.delete(floorId);
    else next.add(floorId);
    persistCollapsedFloors(next);
  }

  function expandAllFloors() {
    persistCollapsedFloors(new Set());
  }

  function collapseAllFloors() {
    persistCollapsedFloors(new Set(floors.map((f) => f.id)));
  }

  function toggleEditMode() {
    setEditMode((v) => {
      // Turning edit ON while floors sit collapsed would hide the very
      // rooms you'd want to rename/delete, forcing a manual expand first —
      // just expand everything the moment edit mode opens.
      if (!v) expandAllFloors();
      return !v;
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

  function deleteFloor(floor: Floor) {
    setConfirmState({
      title: "Delete floor?",
      message: `Delete floor "${floor.name}"? This can't be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        const ok = await withError(() => fetch(`/api/floors/${floor.id}`, { method: "DELETE" }));
        if (ok) load();
      },
    });
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

  function deleteRoom(room: Room) {
    setConfirmState({
      title: "Delete room?",
      message: `Delete room "${room.name}"? This can't be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        const ok = await withError(() => fetch(`/api/rooms/${room.id}`, { method: "DELETE" }));
        if (ok) load();
      },
    });
  }

  function startMoveRoom(room: Room) {
    setMovingRoomId(room.id);
    setMoveTargetFloorId("");
    setEditingRoomId(null);
  }

  async function submitMoveRoom(e: React.FormEvent, room: Room) {
    e.preventDefault();
    const floorId = Number(moveTargetFloorId);
    if (!floorId) return;
    const ok = await withError(() =>
      fetch(`/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floorId }),
      })
    );
    setMovingRoomId(null);
    if (ok) load();
  }

  async function setRoomCategory(room: Room, categoryId: number | null) {
    const ok = await withError(() =>
      fetch(`/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      })
    );
    if (ok) load();
  }

  async function setRoomExcluded(room: Room, excludeFromSuggestions: boolean) {
    const ok = await withError(() =>
      fetch(`/api/rooms/${room.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludeFromSuggestions }),
      })
    );
    if (ok) load();
  }

  // --- Room categories (see room_categories' own schema comment) --------

  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [categoryEditValue, setCategoryEditValue] = useState("");
  const [draggingCategoryId, setDraggingCategoryId] = useState<number | null>(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState<number | null>(null);

  async function submitNewCategory(e: React.FormEvent) {
    e.preventDefault();
    const name = newCategoryName.trim();
    if (!name) return;
    const ok = await withError(() =>
      fetch("/api/room-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    );
    if (ok) {
      setNewCategoryName("");
      setAddingCategory(false);
      load();
    }
  }

  function startEditCategory(cat: RoomCategory) {
    setEditingCategoryId(cat.id);
    setCategoryEditValue(cat.name);
  }

  async function submitCategoryEdit(e: React.FormEvent, cat: RoomCategory) {
    e.preventDefault();
    const name = categoryEditValue.trim();
    if (!name || name === cat.name) {
      setEditingCategoryId(null);
      return;
    }
    const ok = await withError(() =>
      fetch(`/api/room-categories/${cat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    );
    setEditingCategoryId(null);
    if (ok) load();
  }

  function deleteCategory(cat: RoomCategory) {
    const roomsUsingIt = rooms.filter((r) => r.categoryId === cat.id).length;
    setConfirmState({
      title: "Delete room category?",
      message:
        roomsUsingIt > 0
          ? `Delete "${cat.name}"? ${roomsUsingIt} room${roomsUsingIt === 1 ? "" : "s"} currently in it will become one-of-a-kind (no category) instead.`
          : `Delete "${cat.name}"?`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        const ok = await withError(() => fetch(`/api/room-categories/${cat.id}`, { method: "DELETE" }));
        if (ok) load();
      },
    });
  }

  // Plain HTML5 drag events for reordering, same pattern as BookingsTable's
  // own column drag — no library needed for a one-axis list reorder like
  // this. Persists the WHOLE new rank order in one go (simplest way to keep
  // ranks a clean, gap-free sequence) rather than trying to compute a
  // single in-between rank value for just the moved row.
  async function handleCategoryDrop(targetId: number) {
    setDragOverCategoryId(null);
    if (!draggingCategoryId || draggingCategoryId === targetId) return;
    const ordered = [...categories].sort((a, b) => a.rank - b.rank);
    const fromIndex = ordered.findIndex((c) => c.id === draggingCategoryId);
    const toIndex = ordered.findIndex((c) => c.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = ordered.splice(fromIndex, 1);
    ordered.splice(toIndex, 0, moved);
    setDraggingCategoryId(null);
    // Optimistic local reorder so the list doesn't visually snap back while
    // the PATCH calls are in flight.
    setCategories(ordered.map((c, i) => ({ ...c, rank: i })));
    await Promise.all(
      ordered.map((c, i) =>
        c.rank === i
          ? Promise.resolve()
          : fetch(`/api/room-categories/${c.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ rank: i }),
            })
      )
    );
    load();
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

  function deleteBed(bed: Bed) {
    const where = bed.room ? `in ${bed.room.roomName}` : "(currently unplaced)";
    setConfirmState({
      title: "Remove bed?",
      message: `Remove this ${bed.type} bed ${where}? Any booking on it will become unassigned.`,
      confirmLabel: "Remove",
      onConfirm: async () => {
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
      },
    });
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

      <HelpButton title="Using Property Layout">
        <p style={{ marginTop: 0 }}>
          Floors and rooms are the property&apos;s fixed structure. Where a bed sits, and any solo/couple double
          joins, are day-to-day layout — set those on the Dorm Board grid instead.
        </p>
        <p style={{ marginBottom: 0 }}>
          Add a bed here when you buy one, remove one when it breaks. Each bed type below lists every bed of that
          type and which room it&apos;s currently in.
        </p>
      </HelpButton>

      <div className="tr-layout-columns">
        {/* --- Floors & rooms, as a nested tree ------------------------- */}
        <div className="tr-card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <h2 className="tr-section-title" style={{ margin: 0 }}>Floors &amp; Rooms</h2>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={expandAllFloors}>Expand all</button>
            <button type="button" onClick={collapseAllFloors}>Collapse all</button>
            <button type="button" className={editMode ? "primary" : undefined} onClick={toggleEditMode}>
              {editMode ? "Done" : "Edit"}
            </button>
          </div>

          {editMode && (
            <div style={{ marginBottom: 10 }}>
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
          )}

          {floors.length === 0 && (
            <p className="tr-muted" style={{ marginBottom: 12 }}>No floors yet — click Edit to add one.</p>
          )}

          {/* "Storage" holds the system-managed Dorm Storage room (see
              src/lib/dorm-storage.ts) — not part of the user-managed physical
              layout, so it's hidden here rather than editable/deletable. */}
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {floors.filter((floor) => floor.name !== DORM_STORAGE_FLOOR_NAME).map((floor) => {
              const floorRooms = rooms.filter((r) => r.floorId === floor.id);
              const collapsed = collapsedFloorIds.has(floor.id);

              return (
                <li key={floor.id} style={{ borderTop: "1px solid var(--tr-border)", padding: "8px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => toggleFloorCollapsed(floor.id)}
                      aria-label={collapsed ? "Expand floor" : "Collapse floor"}
                      style={{ fontSize: 12, minWidth: 24, minHeight: "unset", padding: "4px 6px" }}
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
                      <strong style={{ flex: 1 }}>{floor.name}</strong>
                    )}

                    {editMode && editingFloorId !== floor.id && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button type="button" onClick={() => startEditFloor(floor)}>Rename</button>
                        <button type="button" className="tr-danger" onClick={() => deleteFloor(floor)}>Delete</button>
                      </div>
                    )}
                  </div>

                  {!collapsed && (
                    <ul style={{ listStyle: "none", margin: "8px 0 0", padding: "0 0 0 30px" }}>
                      {editMode && (
                        addingRoomFloorId === floor.id ? (
                          <li style={{ paddingBottom: 8 }}>
                            <form onSubmit={(e) => submitNewRoom(e, floor.id)} style={{ display: "flex", gap: 8 }}>
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
                          </li>
                        ) : (
                          <li style={{ paddingBottom: 8 }}>
                            <button type="button" onClick={() => startAddRoom(floor.id)}>+ Add Room to this Floor</button>
                          </li>
                        )
                      )}

                      {floorRooms.length === 0 && (
                        <li className="tr-muted" style={{ fontSize: 13 }}>No rooms on this floor yet.</li>
                      )}

                      {floorRooms.map((room) => (
                        <li
                          key={room.id}
                          style={{ borderTop: "1px solid var(--tr-border)", padding: "6px 0" }}
                        >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
                          ) : movingRoomId === room.id ? (
                            <form onSubmit={(e) => submitMoveRoom(e, room)} style={{ display: "flex", gap: 6, flex: 1 }}>
                              <select
                                autoFocus
                                value={moveTargetFloorId}
                                onChange={(e) => setMoveTargetFloorId(e.target.value)}
                                style={{ flex: 1, maxWidth: 220 }}
                              >
                                <option value="">— move to which floor? —</option>
                                {floors
                                  .filter((f) => f.name !== DORM_STORAGE_FLOOR_NAME && f.id !== room.floorId)
                                  .map((f) => (
                                    <option key={f.id} value={f.id}>{f.name}</option>
                                  ))}
                              </select>
                              <button type="submit" className="primary" disabled={!moveTargetFloorId}>Move</button>
                              <button type="button" onClick={() => setMovingRoomId(null)}>Cancel</button>
                            </form>
                          ) : (
                            <span style={{ flex: 1 }}>
                              {room.name}
                              {room.categoryId != null && (
                                <span className="tr-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                                  {categories.find((c) => c.id === room.categoryId)?.name ?? ""}
                                </span>
                              )}
                              {room.excludeFromSuggestions && (
                                <span className="tr-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                                  (excluded from suggestions)
                                </span>
                              )}
                            </span>
                          )}

                          {editMode && editingRoomId !== room.id && movingRoomId !== room.id && (
                            <div style={{ display: "flex", gap: 6 }}>
                              <button type="button" onClick={() => startEditRoom(room)}>Rename</button>
                              <button type="button" onClick={() => startMoveRoom(room)}>Move</button>
                              <button type="button" className="tr-danger" onClick={() => deleteRoom(room)}>Delete</button>
                            </div>
                          )}
                        </div>

                        {/* Move/fix-suggestion settings — see room_categories' own schema
                            comment for what these actually control. Only shown in edit
                            mode, same as rename/move/delete, to keep the read view plain. */}
                        {editMode && editingRoomId !== room.id && movingRoomId !== room.id && (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, paddingLeft: 2, flexWrap: "wrap" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                              <span className="tr-muted">Category:</span>
                              <select
                                value={room.categoryId ?? ""}
                                onChange={(e) => setRoomCategory(room, e.target.value ? Number(e.target.value) : null)}
                                style={{ minHeight: "unset", padding: "3px 6px", fontSize: 12 }}
                              >
                                <option value="">— one of a kind —</option>
                                {categories.map((c) => (
                                  <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                              </select>
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                className="tr-settings-checkbox"
                                checked={room.excludeFromSuggestions}
                                onChange={(e) => setRoomExcluded(room, e.target.checked)}
                              />
                              <span className="tr-muted">Exclude from move/fix suggestions</span>
                            </label>
                          </div>
                        )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* --- Bed inventory --------------------------------------------- */}
        <div className="tr-card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <h2 className="tr-section-title" style={{ margin: 0 }}>Bed Inventory</h2>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className={bedEditMode ? "primary" : undefined}
              onClick={() => {
                setBedEditMode((v) => !v);
                setAddingTypeIdForAdd(null);
                setRemovingTypeId(null);
                setAddingType(false);
              }}
            >
              {bedEditMode ? "Done" : "Edit"}
            </button>
          </div>

          {bedTypes.map((type) => {
            const bedsOfType = beds.filter((b) => b.type === type.name);
            const addState = getAddBedState(type.id);
            const adding = addingTypeIdForAdd === type.id;
            const removing = removingTypeId === type.id;

            return (
              <div key={type.id} style={{ borderTop: "1px solid var(--tr-border)", padding: "10px 0" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontSize: 16 }}>{bedsOfType.length}</strong>
                  <span>{type.name}{bedsOfType.length === 1 ? "" : "s"}</span>
                  <span className="tr-muted" style={{ fontSize: 12 }}>sleeps {type.capacity}</span>
                  <span style={{ flex: 1 }} />
                  {bedEditMode && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setAddingTypeIdForAdd(adding ? null : type.id);
                          setRemovingTypeId(null);
                        }}
                      >
                        {adding ? "Cancel" : "+ Add"}
                      </button>
                      {bedsOfType.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setRemovingTypeId(removing ? null : type.id);
                            setRemoveBedChoice("");
                            setAddingTypeIdForAdd(null);
                          }}
                        >
                          {removing ? "Cancel" : "− Remove"}
                        </button>
                      )}
                    </>
                  )}
                </div>

                {removing && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8, padding: "8px 10px", border: "1px solid var(--tr-border)", borderRadius: 8 }}>
                    <span className="tr-muted" style={{ fontSize: 12 }}>Remove which one?</span>
                    <select value={removeBedChoice} onChange={(e) => setRemoveBedChoice(e.target.value)}>
                      <option value="">— select a bed —</option>
                      {bedsOfType.map((bed) => (
                        <option key={bed.id} value={bed.id}>
                          {bed.room ? `${bed.room.roomName} (${bed.room.floorName})` : "Unplaced"}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="tr-danger"
                      disabled={!removeBedChoice}
                      onClick={async () => {
                        const bed = bedsOfType.find((b) => String(b.id) === removeBedChoice);
                        if (!bed) return;
                        await deleteBed(bed);
                        setRemovingTypeId(null);
                        setRemoveBedChoice("");
                      }}
                    >
                      Remove bed
                    </button>
                  </div>
                )}

                {adding && (
                  <form
                    onSubmit={async (e) => {
                      await submitNewBed(e, type);
                      setAddingTypeIdForAdd(null);
                    }}
                    style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 8, padding: "8px 10px", border: "1px solid var(--tr-border)", borderRadius: 8 }}
                  >
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
                )}
              </div>
            );
          })}

          {bedEditMode && (
          <div style={{ marginTop: 12 }}>
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
          )}
        </div>

        {/* --- Room categories --------------------------------------------
            "Interchangeable rooms" groups for move/fix suggestions — see
            room_categories' own schema comment for the full design (flat,
            manually-curated, not date-scoped). Rank controls suggestion
            priority ordering later; for now it's just the drag order. */}
        <div className="tr-card">
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <h2 className="tr-section-title" style={{ margin: 0 }}>Room Categories</h2>
            <span
              aria-hidden="true"
              className="tr-muted"
              data-tooltip="Rooms in the same category are treated as interchangeable for move/fix suggestions. Drag to reorder — assign a room to a category from its own Edit controls above."
              style={{ cursor: "help", fontSize: 13, border: "1px solid var(--tr-border)", borderRadius: "50%", width: 16, height: 16, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              ?
            </span>
          </div>

          {categories.length === 0 && !addingCategory && (
            <p className="tr-muted" style={{ fontSize: 13 }}>No categories yet — every room is currently one-of-a-kind.</p>
          )}

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {[...categories]
              .sort((a, b) => a.rank - b.rank)
              .map((cat) => {
                const roomCount = rooms.filter((r) => r.categoryId === cat.id).length;
                return (
                  <li
                    key={cat.id}
                    draggable
                    onDragStart={() => setDraggingCategoryId(cat.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragOverCategoryId !== cat.id) setDragOverCategoryId(cat.id);
                    }}
                    onDragLeave={() => setDragOverCategoryId((id) => (id === cat.id ? null : id))}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleCategoryDrop(cat.id);
                    }}
                    onDragEnd={() => {
                      setDraggingCategoryId(null);
                      setDragOverCategoryId(null);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      borderTop: "1px solid var(--tr-border)",
                      padding: "6px 4px",
                      cursor: "grab",
                      opacity: draggingCategoryId === cat.id ? 0.4 : 1,
                      background: dragOverCategoryId === cat.id && draggingCategoryId !== cat.id ? "var(--tr-accent-soft)" : undefined,
                    }}
                  >
                    <span aria-hidden="true" className="tr-muted" style={{ fontSize: 12, letterSpacing: "-1px" }}>⠿</span>
                    {editingCategoryId === cat.id ? (
                      <form onSubmit={(e) => submitCategoryEdit(e, cat)} style={{ display: "flex", gap: 6, flex: 1 }}>
                        <input
                          autoFocus
                          value={categoryEditValue}
                          onChange={(e) => setCategoryEditValue(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button type="submit" className="primary">Save</button>
                        <button type="button" onClick={() => setEditingCategoryId(null)}>Cancel</button>
                      </form>
                    ) : (
                      <>
                        <span style={{ flex: 1 }}>
                          {cat.name}
                          <span className="tr-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                            {roomCount} room{roomCount === 1 ? "" : "s"}
                          </span>
                        </span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" onClick={() => startEditCategory(cat)}>Rename</button>
                          <button type="button" className="tr-danger" onClick={() => deleteCategory(cat)}>Delete</button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
          </ul>

          <div style={{ marginTop: 10 }}>
            {addingCategory ? (
              <form onSubmit={submitNewCategory} style={{ display: "flex", gap: 8 }}>
                <input
                  autoFocus
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="Category name"
                  style={{ flex: 1, maxWidth: 280 }}
                />
                <button type="submit" className="primary">Add</button>
                <button type="button" onClick={() => setAddingCategory(false)}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="primary" onClick={() => setAddingCategory(true)}>
                + Add Category
              </button>
            )}
          </div>
        </div>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />
    </div>
  );
}
