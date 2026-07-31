"use client";

import { useEffect, useState } from "react";

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface GuardianOccupancyPopupProps {
  open: boolean;
  bookingId: number | null;
  guardianName: string;
  initialDate: string;
  onClose: () => void;
  onSaved?: () => void;
}

export default function GuardianOccupancyPopup({
  open,
  bookingId,
  guardianName,
  initialDate,
  onClose,
  onSaved,
}: GuardianOccupancyPopupProps) {
  const [startDate, setStartDate] = useState(initialDate);
  const [endDate, setEndDate] = useState(addDays(initialDate, 1));
  const [noEndDate, setNoEndDate] = useState(false);
  const [isOccupied, setIsOccupied] = useState(true);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStartDate(initialDate);
    setEndDate(addDays(initialDate, 1));
  }, [initialDate, open]);

  if (!open || !bookingId) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    const res = await fetch("/api/guardian-presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId,
        startDate,
        endDate: noEndDate ? null : endDate,
        noEndDate,
        isOccupied,
        note,
      }),
    });

    setSaving(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save custom dates");
      return;
    }

    onSaved?.();
    onClose();
  }

  return (
    <div className="tr-move-modal-backdrop">
      <div className="tr-move-modal" style={{ maxWidth: 520 }}>
        <h3 style={{ marginTop: 0, marginBottom: 8 }}>Custom occupancy dates</h3>
        <p className="tr-muted" style={{ marginTop: 0, marginBottom: 10, fontSize: 12 }}>
          {guardianName}
        </p>

        {error && (
          <p className="tr-badge tr-badge-warn" style={{ marginBottom: 8 }}>
            {error}
          </p>
        )}

        <form onSubmit={save} style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <div>
              <label style={{ display: "block", fontSize: 12 }}>Start date</label>
              <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12 }}>End date</label>
              <input
                type="date"
                disabled={noEndDate}
                required={!noEndDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={noEndDate} onChange={(e) => setNoEndDate(e.target.checked)} />
            No end date (ongoing)
          </label>

          <div>
            <label style={{ display: "block", fontSize: 12 }}>Status</label>
            <select value={isOccupied ? "occupied" : "free"} onChange={(e) => setIsOccupied(e.target.value === "occupied")}>
              <option value="occupied">Occupied</option>
              <option value="free">Free</option>
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 12 }}>Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
