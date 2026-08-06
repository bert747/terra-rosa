"use client";

import { useState } from "react";

export interface AllocationIssue {
  otherBookingId: number;
  otherGuestName: string;
  kind: "room" | "bed";
}

interface EvictionStep {
  bookingId: number;
  guestName: string;
  action: "move" | "split";
  splitDate?: string;
  moveHalf?: "front" | "back";
  newBedId: number;
  newRoomName: string;
}

interface RoomFixOption {
  roomId: number;
  roomName: string;
  moves: { bookingId: number; guestName: string; bedId: number }[];
  rejoins: [number, number][];
  evictions: EvictionStep[];
}

const smallButtonStyle = { minHeight: "unset", padding: "3px 8px", fontSize: 12 };

/**
 * Renders a booking's unmet "Sleeps near"/"Shares bed with" issues (each
 * linking to the other booking involved) plus ONE "Fix" action that finds
 * rooms fitting the WHOLE relationship group at once — not just the pair
 * behind a single issue — so a suggested move never resolves one
 * requirement while leaving another one broken. Never auto-picks a room:
 * more than one can fit, and only a human knows which is actually
 * preferable.
 */
export default function AllocationIssuesPanel({
  bookingId,
  issues,
  onApplied,
}: {
  bookingId: number;
  issues: AllocationIssue[];
  onApplied: () => void;
}) {
  const [fixOpen, setFixOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<RoomFixOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyingRoomId, setApplyingRoomId] = useState<number | null>(null);

  if (issues.length === 0) return null;

  async function toggleFix() {
    if (fixOpen) {
      setFixOpen(false);
      return;
    }
    setFixOpen(true);
    setOptions(null);
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/allocation-fix-options`);
      if (!res.ok) {
        setError("Could not load fix options.");
        return;
      }
      const body: { options: RoomFixOption[] } = await res.json();
      setOptions(body.options);
    } finally {
      setLoading(false);
    }
  }

  async function applyOption(option: RoomFixOption) {
    setApplyingRoomId(option.roomId);
    setError(null);
    try {
      const res = await fetch("/api/bookings/auto-allocate/apply-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves: option.moves, rejoins: option.rejoins, evictions: option.evictions }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not apply that move.");
        return;
      }
      setFixOpen(false);
      onApplied();
    } finally {
      setApplyingRoomId(null);
    }
  }

  return (
    <div className="tr-badge tr-badge-warn" style={{ marginBottom: 12, display: "block", padding: "8px 10px" }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        ⚠ Allocation issue{issues.length > 1 ? "s" : ""}
      </div>
      <ul style={{ margin: "0 0 6px", paddingLeft: 18 }}>
        {issues.map((issue) => (
          <li key={`${issue.otherBookingId}-${issue.kind}`}>
            {issue.kind === "bed" ? "Should share a bed with " : "Should be in the same room as "}
            <a href={`/bookings/${issue.otherBookingId}`}>{issue.otherGuestName}</a>
          </li>
        ))}
      </ul>
      <button type="button" style={smallButtonStyle} onClick={toggleFix}>
        {fixOpen ? "Hide fixes" : issues.length > 1 ? "Fix all" : "Fix"}
      </button>
      {fixOpen && (
        <div style={{ marginTop: 6 }}>
          {loading && <span className="tr-muted">Looking for a room that fits everyone…</span>}
          {error && <div style={{ marginBottom: 4 }}>{error}</div>}
          {options && options.length === 0 && (
            <span className="tr-muted">No room currently fits everyone together — move these bookings manually.</span>
          )}
          {options && options.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
              {options.map((option) => {
                const names = [...new Set(option.moves.map((m) => m.guestName))];
                return (
                  <div key={option.roomId}>
                    {option.evictions.length > 0 && (
                      <div className="tr-muted" style={{ fontSize: 11, marginBottom: 2 }}>
                        First {option.evictions
                          .map((e) => (e.action === "split" ? `splits & moves part of ${e.guestName}'s stay` : `moves ${e.guestName}`))
                          .join(", ")}{" "}
                        to {option.evictions[0].newRoomName} to make room.
                      </div>
                    )}
                    <button
                      type="button"
                      className="primary"
                      style={smallButtonStyle}
                      disabled={applyingRoomId === option.roomId}
                      onClick={() => applyOption(option)}
                    >
                      {applyingRoomId === option.roomId
                        ? "Moving…"
                        : names.length === 1
                          ? `Move ${names[0]} to ${option.roomName}`
                          : `Move ${names.join(", ")} to ${option.roomName}`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
