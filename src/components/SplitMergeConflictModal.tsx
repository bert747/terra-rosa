"use client";

import { useState } from "react";
import { formatDateUk } from "@/lib/dates";
import type { ISODate } from "@/lib/occupancy";

export interface SplitMergeConflictModalState {
  bookingId: number;
  conflicts: { bookingId: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate }[];
  canSwap: boolean;
}

/**
 * Shown when merging a split booking's future parts back onto one bed
 * can't happen cleanly — something else is already in that bed on some of
 * the nights involved. Describes exactly who and when, then offers either
 * a clean swap (only when there's exactly one blocker whose whole stay
 * fits into the bed being vacated) or unallocating just the conflicting
 * nights instead — see src/lib/split-merge.ts for which one applies.
 */
export default function SplitMergeConflictModal({
  state,
  onClose,
  onResolve,
}: {
  state: SplitMergeConflictModalState | null;
  onClose: () => void;
  onResolve: (resolution: "swap" | "unallocate") => Promise<void> | void;
}) {
  const [saving, setSaving] = useState<"swap" | "unallocate" | null>(null);

  if (!state) return null;

  async function choose(resolution: "swap" | "unallocate") {
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
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Can&apos;t merge cleanly</h2>
        <ul style={{ marginTop: 0, marginBottom: 16, paddingLeft: 18 }}>
          {state.conflicts.map((c) => (
            <li key={c.bookingId}>
              {c.guestName} is in this bed from {formatDateUk(c.arrivalDate)} to {formatDateUk(c.departureDate)}
            </li>
          ))}
        </ul>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={onClose} disabled={saving != null}>Cancel</button>
          <button type="button" onClick={() => choose("unallocate")} disabled={saving != null}>
            {saving === "unallocate" ? "Unallocating…" : "Unallocate those nights"}
          </button>
          {state.canSwap && (
            <button type="button" className="primary" onClick={() => choose("swap")} disabled={saving != null}>
              {saving === "swap" ? "Swapping…" : `Swap with ${state.conflicts[0].guestName}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
