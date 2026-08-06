"use client";

import { useState } from "react";

export interface ConfirmModalState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  /** Optional second action button, rendered between Cancel and the primary confirm button — for a genuine 3-way choice (e.g. "This segment" vs "All segments") rather than a plain yes/no. */
  secondaryLabel?: string;
  onSecondary?: () => Promise<void> | void;
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

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await state!.onConfirm();
    setSaving(false);
    onClose();
  }

  async function handleSecondary() {
    if (!state?.onSecondary) return;
    setSaving(true);
    await state.onSecondary();
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
      {/* A <form> so the confirm button — type="submit", autoFocused — is
          this dialog's default action: pressing Enter anywhere in it
          confirms, same as clicking the button, without needing a focused
          input to submit against. */}
      <form className="tr-modal" onSubmit={handleConfirm}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>{state.title}</h2>
        <p style={{ marginBottom: 16 }}>{state.message}</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="tr-btn-soft" onClick={onClose} disabled={saving}>Cancel</button>
          {state.secondaryLabel && (
            <button type="button" onClick={handleSecondary} disabled={saving}>
              {state.secondaryLabel}
            </button>
          )}
          <button type="submit" className="primary" autoFocus disabled={saving}>
            {saving ? "Working…" : state.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
