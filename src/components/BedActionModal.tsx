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
  const [roomId, setRoomId] = useState("");
  const [startDate, setStartDate] = useState<ISODate>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state) return;
    setStartDate(state.defaultDate);
    setRoomId("");
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
            .filter((r) => !r.excludeFromCapacity)
            .map((r) => ({ id: r.id, name: r.name, floorName: floorNameById.get(r.floorId) ?? "" }))
            .sort((a, b) => a.floorName.localeCompare(b.floorName) || a.name.localeCompare(b.name, undefined, { numeric: true }))
        );
      }
    );
  }, [state]);

  if (!state) return null;

  const targetRoomId = state.mode === "storage" ? dormStorageRoomId : Number(roomId);
  const canSubmit = Number.isInteger(targetRoomId) && targetRoomId > 0 && !!startDate;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !state) return;
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
          <label style={{ display: "block", marginBottom: 10 }}>
            <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Room</div>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)} required autoFocus style={{ width: "100%" }}>
              <option value="" disabled>Select a room…</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.floorName} — {r.name}</option>
              ))}
            </select>
          </label>
        )}

        <label style={{ display: "block", marginBottom: 16 }}>
          <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Effective date</div>
          <DateField value={startDate} onChange={setStartDate} required />
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="primary" disabled={saving || !canSubmit}>
            {saving ? "Saving…" : state.mode === "storage" ? "Send to Storage" : "Move Bed"}
          </button>
        </div>
      </form>
    </div>
  );
}
