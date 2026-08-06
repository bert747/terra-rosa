"use client";

import { useEffect, useState } from "react";
import type { ISODate } from "@/lib/occupancy";
import DateField from "@/components/DateField";

export interface BedActionModalState {
  mode: "move" | "storage";
  bedId: number;
  bedLabel: string;
  defaultDate: ISODate;
  /** The bed's room right before this action — passed straight through to onSubmit so the caller can record an undo entry (see actions.moveBed in GridCanvas.tsx). */
  previousRoomId: number;
}

interface RoomOption {
  id: number;
  name: string;
  floorName: string;
}

/**
 * Floor, then room within it — like navigating into a folder — rather than
 * one long flat "floor — room" list. A hostel with several floors/areas
 * made the flat dropdown tall enough to blow past the top of the page; two
 * short steps keeps every screen to a handful of rows.
 */
function RoomPicker({ rooms, value, onChange }: { rooms: RoomOption[]; value: number | null; onChange: (roomId: number) => void }) {
  const [floorName, setFloorName] = useState<string | null>(null);

  const floors = [...new Set(rooms.map((r) => r.floorName))];
  const selected = rooms.find((r) => r.id === value) ?? null;

  if (selected && floorName == null) {
    return (
      <div className="tr-room-picker-selected">
        <span>{selected.floorName} — {selected.name}</span>
        <button type="button" onClick={() => setFloorName(selected.floorName)}>Change</button>
      </div>
    );
  }

  if (floorName == null) {
    return (
      <ul className="tr-room-picker-list">
        {floors.map((name) => (
          <li key={name}>
            <button type="button" onClick={() => setFloorName(name)}>
              {name}
              <span aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }

  const roomsOnFloor = rooms.filter((r) => r.floorName === floorName);
  return (
    <div>
      <button type="button" className="tr-room-picker-back" onClick={() => setFloorName(null)}>
        ‹ {floorName}
      </button>
      <ul className="tr-room-picker-list">
        {roomsOnFloor.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={r.id === value ? "tr-room-picker-active" : undefined}
              onClick={() => {
                onChange(r.id);
                setFloorName(null);
              }}
            >
              {r.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Move Bed / Send to Dorm Storage, from the grid's bed-label context menu.
 * Both just place the bed in a room from an effective date — see POST
 * /api/bed-locations — "storage" mode only skips the room picker because
 * the target (Dorm Storage) is fixed, not because the underlying action
 * differs.
 */
export default function BedActionModal({
  state,
  dormStorageRoomId,
  onClose,
  onSubmit,
}: {
  state: BedActionModalState | null;
  dormStorageRoomId: number;
  onClose: () => void;
  onSubmit: (bedId: number, roomId: number, startDate: ISODate, previousRoomId: number) => Promise<void> | void;
}) {
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [startDate, setStartDate] = useState<ISODate>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state) return;
    setStartDate(state.defaultDate);
    setRoomId(null);
    setSaving(false);
    if (state.mode !== "move") return;

    Promise.all([fetch("/api/rooms").then((r) => r.json()), fetch("/api/floors").then((r) => r.json())]).then(
      ([roomRows, floorRows]: [
        Array<{ id: number; name: string; floorId: number; excludeFromCapacity: boolean }>,
        Array<{ id: number; name: string }>
      ]) => {
        const floorNameById = new Map(floorRows.map((f) => [f.id, f.name]));
        setRooms(
          roomRows
            // A bed is already in its own current room — offering that as a
            // "move" destination isn't a real action.
            .filter((r) => !r.excludeFromCapacity && r.id !== state.previousRoomId)
            .map((r) => ({ id: r.id, name: r.name, floorName: floorNameById.get(r.floorId) ?? "" }))
            .sort((a, b) => a.floorName.localeCompare(b.floorName) || a.name.localeCompare(b.name, undefined, { numeric: true }))
        );
      }
    );
  }, [state]);

  if (!state) return null;

  const targetRoomId = state.mode === "storage" ? dormStorageRoomId : roomId;
  const canSubmit = targetRoomId != null && targetRoomId > 0 && !!startDate;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !state || targetRoomId == null) return;
    setSaving(true);
    await onSubmit(state.bedId, targetRoomId, startDate, state.previousRoomId);
  }

  return (
    <div
      className="tr-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="tr-modal" onSubmit={handleSubmit}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>
          {state.mode === "storage" ? `Send "${state.bedLabel}" to Dorm Storage` : `Move "${state.bedLabel}"`}
        </h2>

        {state.mode === "move" && (
          <div style={{ marginBottom: 10 }}>
            <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Room</div>
            <RoomPicker key={state.bedId} rooms={rooms} value={roomId} onChange={setRoomId} />
          </div>
        )}

        <label style={{ display: "block", marginBottom: 16 }}>
          <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Effective date</div>
          <DateField value={startDate} onChange={setStartDate} required />
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="primary" disabled={saving || !canSubmit}>
            {saving ? "Saving…" : state.mode === "storage" ? "Send to storage" : "Move bed"}
          </button>
        </div>
      </form>
    </div>
  );
}
