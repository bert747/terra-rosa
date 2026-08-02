"use client";

import { useEffect, useState } from "react";
import type { ISODate } from "@/lib/occupancy";
import DateField from "@/components/DateField";

export interface JoinActionModalState {
  bed1Id: number;
  bed2Id: number;
  mode: "double" | "solo";
  title: string;
  defaultStartDate: ISODate;
  /** Prefilled End Date when the bed is currently occupied — the departure date of whatever booking is sitting there, so the join naturally covers exactly that stay by default. */
  defaultEndDate: ISODate | null;
}

/**
 * Start/end date picker for "Join as Couple Double" / "Join as Solo Double",
 * opened instead of firing the join immediately on click. Reuses
 * BedActionModal's overlay/form styling. Leaving End Date blank means
 * open-ended (ongoing) — the server may still narrow that down on its own
 * if it collides with a later join for the same beds (see the
 * snap-to-boundary handling in POST /api/joined-beds).
 */
export default function JoinActionModal({
  state,
  onClose,
  onSubmit,
}: {
  state: JoinActionModalState | null;
  onClose: () => void;
  onSubmit: (startDate: ISODate, endDate: ISODate | null) => Promise<boolean>;
}) {
  const [startDate, setStartDate] = useState<ISODate>("");
  const [endDate, setEndDate] = useState<ISODate | "">("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state) return;
    setStartDate(state.defaultStartDate);
    setEndDate(state.defaultEndDate ?? "");
    setSaving(false);
  }, [state]);

  if (!state) return null;

  const canSubmit = !!startDate && (!endDate || endDate > startDate);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !state) return;
    setSaving(true);
    const ok = await onSubmit(startDate, endDate || null);
    if (ok) return; // caller closes the modal
    setSaving(false); // failed — stay open so dates can be adjusted
  }

  return (
    <div
      className="tr-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="tr-modal" onSubmit={handleSubmit}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>{state.title}</h2>

        <label style={{ display: "block", marginBottom: 10 }}>
          <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Start date</div>
          <DateField value={startDate} onChange={setStartDate} required autoFocus />
        </label>

        <label style={{ display: "block", marginBottom: 16 }}>
          <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>End date (optional — blank means ongoing)</div>
          <DateField value={endDate} onChange={setEndDate} />
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="primary" disabled={saving || !canSubmit}>
            {saving ? "Joining…" : "Join"}
          </button>
        </div>
      </form>
    </div>
  );
}
