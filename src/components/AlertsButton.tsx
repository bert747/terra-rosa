"use client";

import { useEffect, useState } from "react";
import { formatDateUk } from "@/lib/dates";
import type { IssueGroup, UnassignedAlert } from "@/lib/grid-data";

interface EvictionStep {
  bookingId: number;
  guestName: string;
  action: "move" | "split";
  newRoomName: string;
}

interface RoomFixOption {
  roomId: number;
  roomName: string;
  moves: { bookingId: number; guestName: string; bedId: number }[];
  rejoins: [number, number][];
  evictions: EvictionStep[];
}

/**
 * The same "Alerts" data/actions the grid's own toolbar button shows (see
 * GridCanvas.tsx) — bookings needing a bed, and allocation issues (a
 * declared Sleeps-near/Shares-bed pairing that isn't actually being met),
 * with Allocate/Fix actions for both. A separate, simpler implementation
 * rather than sharing GridCanvas's own code: that one integrates with the
 * grid's undo/redo history stack, which has no equivalent here — this
 * version just refetches its own alert list after acting, and calls
 * `onChanged` (if given) so a host page can refresh anything else on
 * screen that a bed assignment might affect (e.g. Bookings' own Room
 * column).
 */
export default function AlertsButton({ onChanged }: { onChanged?: () => void }) {
  const [alerts, setAlerts] = useState<UnassignedAlert[]>([]);
  const [issueGroups, setIssueGroups] = useState<IssueGroup[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoAllocating, setAutoAllocating] = useState(false);
  const [allocatingId, setAllocatingId] = useState<number | "bulk" | null>(null);
  const [fixingAll, setFixingAll] = useState(false);
  const [fixOpenGroupId, setFixOpenGroupId] = useState<number | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [fixOptions, setFixOptions] = useState<RoomFixOption[] | null>(null);
  const [applyingFixRoomId, setApplyingFixRoomId] = useState<number | null>(null);

  async function load() {
    const res = await fetch("/api/alerts");
    if (!res.ok) return;
    const body: { alerts: UnassignedAlert[]; issueGroups: IssueGroup[] } = await res.json();
    setAlerts(body.alerts);
    setIssueGroups(body.issueGroups);
  }

  useEffect(() => {
    load();
  }, []);

  async function runAutoAllocate(bookingId?: number) {
    setAutoAllocating(true);
    setAllocatingId(bookingId ?? "bulk");
    try {
      await fetch("/api/bookings/auto-allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingId != null ? { bookingId } : { withinDays: 7 }),
      });
      await load();
      onChanged?.();
    } finally {
      setAutoAllocating(false);
      setAllocatingId(null);
    }
  }

  async function toggleGroupFix(bookingId: number) {
    if (fixOpenGroupId === bookingId) {
      setFixOpenGroupId(null);
      return;
    }
    setFixOpenGroupId(bookingId);
    setFixOptions(null);
    setFixError(null);
    setFixLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/allocation-fix-options`);
      if (!res.ok) {
        setFixError("Could not load fix options.");
        return;
      }
      const body: { options: RoomFixOption[] } = await res.json();
      setFixOptions(body.options);
    } finally {
      setFixLoading(false);
    }
  }

  async function applyGroupFixOption(option: RoomFixOption) {
    setApplyingFixRoomId(option.roomId);
    try {
      await fetch("/api/bookings/auto-allocate/apply-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves: option.moves, rejoins: option.rejoins, evictions: option.evictions }),
      });
      setFixOpenGroupId(null);
      await load();
      onChanged?.();
    } finally {
      setApplyingFixRoomId(null);
    }
  }

  async function runFixAll() {
    setFixingAll(true);
    try {
      for (const g of issueGroups) {
        const res = await fetch(`/api/bookings/${g.bookingId}/allocation-fix-options`);
        if (!res.ok) continue;
        const body: { options: RoomFixOption[] } = await res.json();
        if (!body.options || body.options.length === 0) continue;
        const cheapest = [...body.options].sort((a, b) => a.evictions.length - b.evictions.length)[0];
        await fetch("/api/bookings/auto-allocate/apply-move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ moves: cheapest.moves, rejoins: cheapest.rejoins, evictions: cheapest.evictions }),
        });
      }
      await load();
      onChanged?.();
    } finally {
      setFixingAll(false);
    }
  }

  if (alerts.length + issueGroups.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      <button type="button" onClick={() => setMenuOpen((v) => !v)} data-tooltip="Allocation issues">
        Alerts <span className="tr-actions-badge">{alerts.length + issueGroups.length}</span>
      </button>
      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setMenuOpen(false)} />
          <div className="tr-actions-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40 }}>
            {alerts.length > 0 && (
              <>
                <div className="tr-actions-menu-title">
                  Needs a bed ({alerts.length})
                  <button
                    type="button"
                    className="primary"
                    disabled={autoAllocating}
                    onClick={() => runAutoAllocate()}
                    style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11, marginLeft: "auto" }}
                  >
                    {allocatingId === "bulk" ? "Allocating…" : "Auto-allocate next 7 days"}
                  </button>
                </div>
                <ul className="tr-actions-menu-list">
                  {alerts.map((a) => (
                    <li
                      key={a.id}
                      style={{ cursor: autoAllocating ? "default" : "pointer" }}
                      onClick={() => !autoAllocating && runAutoAllocate(a.id)}
                    >
                      <a href={`/bookings/${a.id}`} onClick={(e) => e.stopPropagation()}>
                        {a.guestName}
                      </a>
                      <span className="tr-muted" style={{ fontSize: 11 }}>
                        {formatDateUk(a.arrivalDate)}–{formatDateUk(a.departureDate)}
                      </span>
                      <button
                        type="button"
                        className="tr-btn-soft"
                        disabled={autoAllocating}
                        onClick={(e) => {
                          e.stopPropagation();
                          runAutoAllocate(a.id);
                        }}
                        style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                      >
                        {allocatingId === a.id ? "…" : "Allocate"}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {issueGroups.length > 0 && (
              <>
                <div className="tr-actions-menu-title">
                  Allocation issues ({issueGroups.length})
                  <button
                    type="button"
                    className="primary"
                    disabled={fixingAll}
                    onClick={runFixAll}
                    style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11, marginLeft: "auto" }}
                  >
                    {fixingAll ? "Fixing…" : "Fix all"}
                  </button>
                </div>
                <ul className="tr-actions-menu-list">
                  {issueGroups.map((g) => (
                    <li key={g.bookingId} style={{ display: "block" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => toggleGroupFix(g.bookingId)}>
                        <div style={{ flex: 1 }}>{g.guestNames.join(", ")}</div>
                        <button
                          type="button"
                          className="tr-btn-soft"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroupFix(g.bookingId);
                          }}
                          style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                        >
                          {fixOpenGroupId === g.bookingId ? "Hide" : "Fix"}
                        </button>
                      </div>
                      {fixOpenGroupId === g.bookingId && (
                        <div style={{ marginTop: 4, marginBottom: 6 }}>
                          {fixLoading && <span className="tr-muted" style={{ fontSize: 11 }}>Looking for a room…</span>}
                          {fixError && <div style={{ fontSize: 11, marginBottom: 4 }}>{fixError}</div>}
                          {fixOptions && fixOptions.length === 0 && (
                            <span className="tr-muted" style={{ fontSize: 11 }}>No room currently fits everyone — move manually.</span>
                          )}
                          {fixOptions && fixOptions.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                              {fixOptions.map((option) => {
                                const names = [...new Set(option.moves.map((m) => m.guestName))];
                                return (
                                  <div key={option.roomId}>
                                    {option.evictions.length > 0 && (
                                      <div className="tr-muted" style={{ fontSize: 10 }}>
                                        First {option.evictions
                                          .map((e) => (e.action === "split" ? `splits & moves part of ${e.guestName}'s stay` : `moves ${e.guestName}`))
                                          .join(", ")}{" "}
                                        to {option.evictions[0].newRoomName}.
                                      </div>
                                    )}
                                    <button
                                      type="button"
                                      className="tr-btn-soft"
                                      disabled={applyingFixRoomId === option.roomId}
                                      onClick={() => applyGroupFixOption(option)}
                                      style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                                    >
                                      {applyingFixRoomId === option.roomId ? "Moving…" : `Move ${names.join(", ")} to ${option.roomName}`}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
