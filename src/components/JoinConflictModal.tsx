"use client";

import { useState } from "react";
import { formatDateUk } from "@/lib/dates";
import type { ISODate } from "@/lib/occupancy";

export interface JoinConflictModalState {
  /** The genuinely-colliding future join for this exact bed pair. */
  conflictStartDate: ISODate;
}

/**
 * Shown instead of silently trimming when a requested join collides with a
 * FUTURE join already scheduled for the same bed pair (see the
 * `futureConflict` 409 payload from POST /api/joined-beds) — lets the user
 * choose to overwrite the existing future join outright, or trim the new
 * one to stop cleanly before it, rather than that decision happening
 * invisibly on their behalf.
 */
export default function JoinConflictModal({
  state,
  onClose,
  onResolve,
}: {
  state: JoinConflictModalState | null;
  onClose: () => void;
  onResolve: (resolution: "overwrite" | "trim") => Promise<void> | void;
}) {
  const [saving, setSaving] = useState<"overwrite" | "trim" | null>(null);

  if (!state) return null;

  async function choose(resolution: "overwrite" | "trim") {
    setSaving(resolution);
    await onResolve(resolution);
    setSaving(null);
  }

  return (
    <div
      className="tr-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tr-modal">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Existing joined state ahead</h2>
        <p style={{ marginBottom: 16 }}>
          There is an existing joined state starting on {formatDateUk(state.conflictStartDate)}. Do you want to
          overwrite it, or trim this new join to stop before it?
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={saving != null}>Cancel</button>
          <button type="button" onClick={() => choose("trim")} disabled={saving != null}>
            {saving === "trim" ? "Trimming…" : "Trim to fit"}
          </button>
          <button type="button" className="primary" onClick={() => choose("overwrite")} disabled={saving != null}>
            {saving === "overwrite" ? "Overwriting…" : "Overwrite"}
          </button>
        </div>
      </div>
    </div>
  );
}
