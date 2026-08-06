"use client";

import { useState } from "react";
import { formatDateUk } from "@/lib/dates";
import type { ISODate } from "@/lib/occupancy";

export interface PlannedChangeConflictModalState {
  /** What they're currently booked into, e.g. "Single beds" or "the Double". */
  configDescription: string;
  affected: { bookingId: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate }[];
  /** The day after the last of them departs — the earliest date the change could still happen. */
  pushedDate: ISODate;
}

/**
 * Shown instead of silently cancelling a planned bed move/type change when
 * a booking is already relying on the CURRENT setup for longer than the
 * change accounted for (see findBookingsAffectedByCancel) — deliberately
 * neutral about which of "cancel" or "delay" is right, since the same data
 * shape covers two different real situations (a couple booked EXPECTING
 * the new double, vs. an unrelated single guest who just happens to be in
 * one of the beds) that only staff can actually tell apart.
 */
export default function PlannedChangeConflictModal({
  state,
  onClose,
  onResolve,
}: {
  state: PlannedChangeConflictModalState | null;
  onClose: () => void;
  onResolve: (resolution: "cancel" | "delay") => Promise<void> | void;
}) {
  const [saving, setSaving] = useState<"cancel" | "delay" | null>(null);

  if (!state) return null;

  async function choose(resolution: "cancel" | "delay") {
    setSaving(resolution);
    await onResolve(resolution);
    setSaving(null);
  }

  const names = state.affected.map((a) => a.guestName);
  const namesText = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
  const earliestArrival = state.affected.reduce((min, a) => (a.arrivalDate < min ? a.arrivalDate : min), state.affected[0].arrivalDate);
  const latestDeparture = state.affected.reduce((max, a) => (a.departureDate > max ? a.departureDate : max), state.affected[0].departureDate);

  return (
    <div
      className="tr-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tr-modal">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>This change conflicts with existing bookings</h2>
        <p style={{ marginTop: 0, marginBottom: 16 }}>
          <strong>{namesText}</strong> {names.length > 1 ? "are" : "is"} already allocated to use {state.configDescription} from{" "}
          <strong>{formatDateUk(earliestArrival)}</strong> to <strong>{formatDateUk(latestDeparture)}</strong>.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={onClose} disabled={saving != null}>Keep as planned</button>
          <button type="button" onClick={() => choose("cancel")} disabled={saving != null}>
            {saving === "cancel" ? "Cancelling…" : `Cancel — leave as ${state.configDescription}`}
          </button>
          <button type="button" className="primary" onClick={() => choose("delay")} disabled={saving != null}>
            {saving === "delay" ? "Delaying…" : `Delay until ${formatDateUk(state.pushedDate)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
