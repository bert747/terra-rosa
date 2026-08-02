"use client";

import { useState } from "react";

export interface ConfirmModalState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
}

/**
 * Generic "are you sure?" confirmation — used before any destructive-ish
 * grid action that isn't easily reversible by eye (Split Booking, Merge
 * Bookings) even though it IS on the undo/redo stack, so the user gets a
 * clear moment to back out before the request fires at all.
 */
export default function ConfirmModal({ state, onClose }: { state: ConfirmModalState | null; onClose: () => void }) {
  const [saving, setSaving] = useState(false);

  if (!state) return null;

  async function handleConfirm() {
    setSaving(true);
    await state!.onConfirm();
    setSaving(false);
    onClose();
  }

  return (
    <div
      className="tr-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tr-modal">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>{state.title}</h2>
        <p style={{ marginBottom: 16 }}>{state.message}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
            {saving ? "Working…" : state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
