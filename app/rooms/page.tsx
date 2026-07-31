"use client";

import { useEffect, useState } from "react";

type BedType = "single" | "queen" | "joined_single_pair";

interface RoomBed {
  id: number;
  roomId: number;
  bedType: BedType;
  sortOrder: number;
}

interface Room {
  id: number;
  name: string;
  locationOrType: string | null;
  displayOrder: number | null;
  defaultBedCount: number;
  isActive: boolean;
  notes: string | null;
  roomBeds: RoomBed[];
}
interface InventoryState {
  singleBeds: number;
  queenBeds: number;
  joinedSinglePairBeds: number;
}

const EMPTY_FORM = {
  name: "",
  locationOrType: "",
  defaultBedCount: 2,
  startDate: "",
  endDate: "",
  ongoing: false,
  note: "",
};

interface InventoryAction {
  mode: "add" | "remove";
  bedType: BedType;
  roomId: string;
  startDate: string;
  endDate: string;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const BED_TYPE_LABELS: Record<BedType, string> = {
  single: "single",
  queen: "queen",
  joined_single_pair: "2 singles together",
};

export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [inventory, setInventory] = useState<InventoryState>({ singleBeds: 0, queenBeds: 0, joinedSinglePairBeds: 0 });
  const [error, setError] = useState<string | null>(null);
  const [showRoomModal, setShowRoomModal] = useState(false);
  const [showInventoryModal, setShowInventoryModal] = useState(false);
  const [inventoryEditMode, setInventoryEditMode] = useState(false);
  const [savingInventoryOrder, setSavingInventoryOrder] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [inventoryAction, setInventoryAction] = useState<InventoryAction | null>(null);

  async function load() {
    const [r, inv] = await Promise.all([
      fetch("/api/rooms").then((res) => res.json()),
      fetch("/api/bed-inventory").then((res) => res.json()),
    ]);
    setRooms(r);
    setInventory(inv);
  }

  useEffect(() => {
    load();
  }, []);

  function openRoomModal(room?: Room) {
    const startDate = todayISO();
    setEditingRoom(room ?? null);
    setForm({
      name: room?.name ?? "",
      locationOrType: room?.locationOrType ?? "",
      defaultBedCount: room?.defaultBedCount ?? 2,
      startDate,
      endDate: addDays(startDate, 7),
      ongoing: false,
      note: "",
    });
    setShowRoomModal(true);
  }

  async function confirmInventoryAction() {
    if (!inventoryAction) return;
    const roomId = Number(inventoryAction.roomId);
    if (!roomId) {
      setError(`Select a room to ${inventoryAction.mode} this bed.`);
      return;
    }
    if (!inventoryAction.startDate) {
      setError("Start date is required.");
      return;
    }
    if (inventoryAction.endDate && inventoryAction.startDate >= inventoryAction.endDate) {
      setError("End date must be after the start date.");
      return;
    }

    setError(null);

    const room = rooms.find((entry) => entry.id === roomId);
    if (!room) {
      setError("Selected room was not found.");
      return;
    }

    const today = todayISO();
    const isImmediate = inventoryAction.startDate === today;

    async function createNote(date: string, noteText: string) {
      const noteRes = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, roomId, noteText }),
      });
      if (!noteRes.ok) {
        const body = await noteRes.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not save move note.");
      }
    }

    const isJoined = inventoryAction.bedType === "joined_single_pair";
    const addNote = isJoined
      ? `Move 2 beds from single setup to joined double setup in ${room.name}`
      : `Move 1 ${BED_TYPE_LABELS[inventoryAction.bedType]} bed from storage to ${room.name}`;
    const removeNote = isJoined
      ? `Move 2 beds from joined double setup to single setup in ${room.name}`
      : `Move 1 ${BED_TYPE_LABELS[inventoryAction.bedType]} bed from ${room.name} to storage`;

    if (inventoryAction.mode === "add") {
      if (isImmediate) {
        const res = await fetch("/api/room-beds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId, bedType: inventoryAction.bedType }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "Could not add bed.");
          return;
        }
      } else {
        try {
          await createNote(inventoryAction.startDate, addNote);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not schedule bed setup.");
          return;
        }
      }

      if (inventoryAction.endDate) {
        try {
          await createNote(inventoryAction.endDate, removeNote);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not schedule bed reversal.");
          return;
        }
      }
    } else {
      const bed = room?.roomBeds.find((entry) => entry.bedType === inventoryAction.bedType);
      if (!bed) {
        setError("That room does not currently have a bed of that type.");
        return;
      }

      if (isImmediate) {
        const res = await fetch(`/api/room-beds/${bed.id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "Could not remove bed.");
          return;
        }
      } else {
        try {
          await createNote(inventoryAction.startDate, removeNote);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not schedule bed removal.");
          return;
        }
      }

      if (inventoryAction.endDate) {
        try {
          await createNote(inventoryAction.endDate, addNote);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not schedule bed restoration.");
          return;
        }
      }
    }

    setInventoryAction(null);
    await load();
  }

  function moveRoom(from: number, to: number) {
    if (to < 0 || to >= rooms.length) return;
    const next = [...rooms];
    const [picked] = next.splice(from, 1);
    next.splice(to, 0, picked);
    setRooms(next);
  }

  async function saveRoomOrder() {
    setSavingInventoryOrder(true);
    setError(null);
    const res = await fetch("/api/rooms/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomIds: rooms.map((room) => room.id) }),
    });
    setSavingInventoryOrder(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save room order.");
      return;
    }
    setInventoryEditMode(false);
    load();
  }

  async function archiveRoom(room: Room) {
    setError(null);
    if (!window.confirm(`Archive ${room.name}? This hides it from active room lists.`)) return;

    const res = await fetch(`/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive: true }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not archive room.");
      return;
    }

    load();
  }

  async function saveRoom(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Room name is required.");
      return;
    }
    if (!form.ongoing && (!form.startDate || !form.endDate)) {
      setError("Please provide a start date and end date, or mark the change as ongoing.");
      return;
    }
    if (!form.ongoing && form.startDate >= form.endDate) {
      setError("End date must be after the start date.");
      return;
    }

    const payload = {
      name: form.name.trim(),
      locationOrType: form.locationOrType.trim() || null,
      defaultBedCount: Number(form.defaultBedCount),
      notes: form.note.trim() || null,
    };

    const roomRes = editingRoom
      ? await fetch(`/api/rooms/${editingRoom.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

    if (!roomRes.ok) {
      const body = await roomRes.json().catch(() => ({}));
      setError(body.error ?? "Could not save room.");
      return;
    }

    const room = await roomRes.json();
    const roomId = Number(room.id);

    const currentBedCount = editingRoom?.roomBeds.length ?? 0;
    const nextBedCount = Number(form.defaultBedCount);
    const diff = nextBedCount - currentBedCount;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        await fetch("/api/room-beds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId, bedType: "single" }),
        });
      }
    } else if (diff < 0 && editingRoom) {
      const bedsToRemove = [...editingRoom.roomBeds]
        .sort((a, b) => b.sortOrder - a.sortOrder || b.id - a.id)
        .slice(0, Math.abs(diff));
      for (const bed of bedsToRemove) {
        await fetch(`/api/room-beds/${bed.id}`, { method: "DELETE" });
      }
    }

    const effectiveEndDate = form.ongoing ? "9999-12-31" : form.endDate;
    const overrideNote = form.note.trim() || "Room setup change";

    if (form.startDate && effectiveEndDate) {
      await fetch("/api/room-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          startDate: form.startDate,
          endDate: effectiveEndDate,
          bedCount: Number(form.defaultBedCount),
          note: overrideNote,
        }),
      });
    }

    setShowRoomModal(false);
    setEditingRoom(null);
    setForm(EMPTY_FORM);
    await load();
  }

  return (
    <div className="tr-shell">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Rooms</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              setInventoryEditMode((v) => !v);
              setError(null);
            }}
          >
            {inventoryEditMode ? "Cancel rearrange" : "Edit / rearrange"}
          </button>
          {inventoryEditMode && (
            <button type="button" className="primary" onClick={saveRoomOrder} disabled={savingInventoryOrder}>
              {savingInventoryOrder ? "Saving..." : "Save order"}
            </button>
          )}
          <button type="button" onClick={() => setShowInventoryModal(true)}>
            Bed inventory
          </button>
          <button type="button" className="primary" onClick={() => openRoomModal()}>
            Add room
          </button>
        </div>
      </div>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card">
        <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 8 }}>
          Rooms are grouped like the grid. This page is read-only for where beds live — to move a bed between
          rooms, go to the <a href="/grid">Grid</a> and drag its bed number into the destination room; that's the
          single source of truth for bed moves now.
        </p>
        {inventoryEditMode && (
          <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 8 }}>
            Rearrange room order with the arrow buttons. Archive appears only in this mode.
          </p>
        )}
        <div className="tr-table-wrap">
          <table className="tr-table">
          <thead>
            <tr>
              <th>Room</th>
              <th>Beds</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rooms.flatMap((r, i) => {
              const currentGroup = r.locationOrType ?? "Ungrouped";
              const prevGroup = i > 0 ? rooms[i - 1].locationOrType ?? "Ungrouped" : null;
              const rows: React.ReactNode[] = [];

              if (currentGroup !== prevGroup) {
                rows.push(
                  <tr key={`group-${currentGroup}-${r.id}`} className="tr-grid-group-row">
                    <td colSpan={4}>{currentGroup}</td>
                  </tr>
                );
              }

              rows.push(
                <tr key={r.id}>
                  <td>
                    <div style={{ display: "inline-flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" }}>
                      <strong>{r.name}</strong>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 24 }}>
                      {r.roomBeds.map((bed) => (
                        <span
                          key={bed.id}
                          title={BED_TYPE_LABELS[bed.bedType]}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            minWidth: 42,
                            height: 22,
                            padding: "0 8px",
                            borderRadius: 6,
                            border: "1px solid var(--tr-border)",
                            background: "#f7efe3",
                            fontSize: 10,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {BED_TYPE_LABELS[bed.bedType]}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="tr-muted">{r.notes}</td>
                  <td className="tr-col-actions">
                    <button type="button" onClick={() => openRoomModal(r)}>
                      Edit
                    </button>
                    {inventoryEditMode && (
                      <>
                        <button type="button" onClick={() => moveRoom(i, i - 1)} disabled={i === 0} style={{ marginLeft: 6 }}>
                          ↑
                        </button>
                        <button type="button" onClick={() => moveRoom(i, i + 1)} disabled={i === rooms.length - 1} style={{ marginLeft: 6 }}>
                          ↓
                        </button>
                        <button
                          type="button"
                          className="tr-danger"
                          onClick={() => archiveRoom(r)}
                          style={{ marginLeft: 6 }}
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );

              return rows;
            })}
          </tbody>
          </table>
        </div>
      </div>

      {showRoomModal && (
        <div className="tr-move-modal-backdrop">
          <div className="tr-move-modal" style={{ maxWidth: 560 }}>
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>{editingRoom ? "Edit room" : "Add room"}</h3>
            <form onSubmit={saveRoom} style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12 }}>Name</label>
                  <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12 }}>Location / type</label>
                  <input value={form.locationOrType} onChange={(e) => setForm({ ...form, locationOrType: e.target.value })} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12 }}>Beds</label>
                  <input type="number" min={0} value={form.defaultBedCount} onChange={(e) => setForm({ ...form, defaultBedCount: Number(e.target.value) })} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12 }}>Start date</label>
                  <input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12 }}>End date</label>
                  <input type="date" disabled={form.ongoing} required={!form.ongoing} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12 }}>Ongoing</label>
                  <div style={{ marginTop: 4 }}>
                    <input type="checkbox" checked={form.ongoing} onChange={(e) => setForm({ ...form, ongoing: e.target.checked })} />
                  </div>
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12 }}>Notes</label>
                <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => { setShowRoomModal(false); setEditingRoom(null); setError(null); }}>
                  Cancel
                </button>
                <button type="submit" className="primary">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showInventoryModal && (
        <div className="tr-move-modal-backdrop">
          <div className="tr-move-modal" style={{ maxWidth: 520 }}>
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>Bed inventory</h3>
            <div style={{ display: "grid", gap: 10 }}>
              {([
                ["single", inventory.singleBeds],
                ["queen", inventory.queenBeds],
                ["joined_single_pair", inventory.joinedSinglePairBeds],
              ] as Array<[BedType, number]>).map(([bedType, count]) => (
                <div key={bedType} className="tr-form-section" style={{ margin: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div>
                      <strong>{BED_TYPE_LABELS[bedType]}</strong>
                      <div className="tr-muted" style={{ fontSize: 12 }}>{count} in rooms</div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => setInventoryAction({ mode: "add", bedType, roomId: "", startDate: todayISO(), endDate: "" })}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => setInventoryAction({ mode: "remove", bedType, roomId: "", startDate: todayISO(), endDate: "" })}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {inventoryAction && (
                <div className="tr-form-section" style={{ margin: 0 }}>
                  <div style={{ marginBottom: 8, fontWeight: 600 }}>
                    {inventoryAction.mode === "add" ? "Add" : "Remove"} {BED_TYPE_LABELS[inventoryAction.bedType]}
                  </div>
                  <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
                    {inventoryAction.mode === "add" ? "Room to add it to" : "Room to take it from"}
                  </label>
                  <select
                    value={inventoryAction.roomId}
                    onChange={(e) => setInventoryAction({ ...inventoryAction, roomId: e.target.value })}
                  >
                    <option value="">— select room —</option>
                    {rooms
                      .filter((room) =>
                        inventoryAction.mode === "add"
                          ? true
                          : room.roomBeds.some((bed) => bed.bedType === inventoryAction.bedType)
                      )
                      .map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.name}
                        </option>
                      ))}
                  </select>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 8 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 12 }}>Start date</label>
                      <input
                        type="date"
                        required
                        value={inventoryAction.startDate}
                        onChange={(e) => setInventoryAction({ ...inventoryAction, startDate: e.target.value })}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 12 }}>End date (optional)</label>
                      <input
                        type="date"
                        value={inventoryAction.endDate}
                        onChange={(e) => setInventoryAction({ ...inventoryAction, endDate: e.target.value })}
                      />
                    </div>
                  </div>
                  <p className="tr-muted" style={{ marginBottom: 0, marginTop: 8, fontSize: 12 }}>
                    Leave end date blank to keep this move ongoing.
                  </p>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
                    <button type="button" onClick={() => setInventoryAction(null)}>
                      Cancel
                    </button>
                    <button type="button" className="primary" onClick={confirmInventoryAction}>
                      Confirm
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => { setInventoryAction(null); setShowInventoryModal(false); }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
