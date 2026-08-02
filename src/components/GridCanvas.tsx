"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import { eventColourStyle, roomColourStyle } from "@/lib/room-colours";
import type { GridData } from "@/lib/grid-data";
import { addDays, type ISODate } from "@/lib/occupancy";
import ToastStack, { type ToastMessage } from "@/components/ToastStack";
import ContextMenu, { type ContextMenuItem, type ContextMenuState } from "@/components/ContextMenu";
import BedActionModal, { type BedActionModalState } from "@/components/BedActionModal";
import JoinActionModal, { type JoinActionModalState } from "@/components/JoinActionModal";
import JoinConflictModal, { type JoinConflictModalState } from "@/components/JoinConflictModal";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import DateField from "@/components/DateField";

const COLUMN_WIDTH = 64;
const ROOM_COL_WIDTH = 140;
const BED_COL_WIDTH = 110;
const YEARS_BACK = 2;
const YEARS_FORWARD = 2;
// The loaded window stays a fixed ~60 days wide the whole time — as the
// visible range nears an edge, the window SHIFTS (fetches the next stretch,
// drops the far side) rather than growing, so the DOM/data payload never
// balloons no matter how far someone scrolls in one session.
const ROLLING_WINDOW_DAYS = 60;
const EDGE_BUFFER_DAYS = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayOfWeek(date: ISODate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function weekday(date: ISODate): string {
  return WEEKDAYS[dayOfWeek(date)];
}

function isWeekend(date: ISODate): boolean {
  const day = dayOfWeek(date);
  return day === 0 || day === 6;
}

// Weekend shading renders as one continuous "wallpaper" tiled across the
// real calendar (7-day repeating gradient, Sun/Sat bands tinted) rather than
// a per-cell class toggle. A booking pill spans one <td> via colSpan across
// however many dates it covers — if that run happened to include a weekend
// boundary, a per-cell class would either force the pill to break there
// (splitting/repeating the guest name) or paint the wrong dates. Anchoring
// this gradient to each cell's own first date and letting CSS tile it means
// the right days land shaded inside a pill of any width, with no run-breaking
// needed. See .tr-grid-cell / .tr-grid-inactive in globals.css, which must
// keep WEEK_CYCLE_WIDTH (448px = COLUMN_WIDTH * 7) in sync with this file.
const WEEK_CYCLE_WIDTH = COLUMN_WIDTH * 7;
const WEEKEND_TINT = "rgba(0, 0, 0, 0.055)";
const WEEKEND_GRADIENT = `repeating-linear-gradient(to right, ${WEEKEND_TINT} 0, ${WEEKEND_TINT} ${COLUMN_WIDTH}px, transparent ${COLUMN_WIDTH}px, transparent ${COLUMN_WIDTH * 6}px, ${WEEKEND_TINT} ${COLUMN_WIDTH * 6}px, ${WEEKEND_TINT} ${WEEK_CYCLE_WIDTH}px)`;

function weekendOverlayVars(date: ISODate): React.CSSProperties {
  const offset = dayOfWeek(date) * COLUMN_WIDTH;
  return {
    ["--tr-weekend-image" as string]: WEEKEND_GRADIENT,
    ["--tr-weekend-pos" as string]: `${-offset}px 0`,
  } as React.CSSProperties;
}

function addDaysIso(date: ISODate, days: number): ISODate {
  return addDays(date, days);
}

interface UnassignedBooking {
  guestName: string;
  arrivalDate: string;
  departureDate: string;
}

// --- Occupancy index: which booking(s) sit on a given bed on a given date -
//
// The drag's collision check needs to answer "is this target bed free for
// the dragged booking's date range?" — and, for the swap-reciprocity check,
// "would moving booking X's OWN unchanged dates into bed Y collide with
// anything else there?" — without re-deriving any of it from the DOM.
// Module-level (like pillDragState below) and rebuilt via a useEffect
// whenever `data` changes, keyed "bedId:date" -> bookings present that
// night. A plain array (not a Set) per key because a capacity-2 native bed
// (Queen/1.5/Double) can have two different bookings — one per slot — on
// the same date.
interface OccupancyEntry {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}
type OccupancyIndex = Map<string, OccupancyEntry[]>;
let occupancyIndex: OccupancyIndex = new Map();

// bedId -> how many bookings that bed can hold at once (unit.slots.length is
// already exactly this — 2 for a native Queen/1.5/Double, 1 for everything
// else, including each half of a joined pair, which are separate bedIds
// each with their own capacity 1). Rebuilt alongside occupancyIndex — see
// onPillPointerMove's move branch, which needs this to tell "the target bed
// has room for one more" (a plain valid drop) apart from "the target bed is
// genuinely full" (a swap candidate, or invalid) — the old capacity-blind
// check treated ANY existing occupant as blocking, so dropping a second
// guest onto an otherwise-empty second slot of a capacity-2 bed was
// misread as needing to evict whoever was already there.
let bedCapacityIndex: Map<number, number> = new Map();

function occupancyKey(bedId: number, date: ISODate): string {
  return `${bedId}:${date}`;
}

function buildBedCapacityIndex(grid: RoomGridRow[]): Map<number, number> {
  const index = new Map<number, number>();
  for (const room of grid) {
    for (const unit of room.units) {
      index.set(unit.bedId, unit.slots.length);
    }
  }
  return index;
}

function buildOccupancyIndex(grid: RoomGridRow[], dates: ISODate[]): OccupancyIndex {
  const index: OccupancyIndex = new Map();
  for (const room of grid) {
    for (const unit of room.units) {
      for (const slot of unit.slots) {
        slot.cells.forEach((cell, i) => {
          if (cell.state !== "booked" || !cell.booking || !dates[i]) return;
          const key = occupancyKey(unit.bedId, dates[i]);
          const existing = index.get(key);
          const entry: OccupancyEntry = {
            id: cell.booking.id,
            guestName: cell.booking.guestName,
            arrivalDate: cell.booking.arrivalDate,
            departureDate: cell.booking.departureDate,
          };
          if (existing) existing.push(entry);
          else index.set(key, [entry]);
        });
      }
    }
  }
  return index;
}

/** Every OTHER booking occupying `bedId` on any night in [arrivalDate, departureDate). */
function conflictingBookings(
  bedId: number,
  arrivalDate: ISODate,
  departureDate: ISODate,
  excludeBookingId: number
): OccupancyEntry[] {
  const conflicts = new Map<number, OccupancyEntry>();
  for (let d = arrivalDate; d < departureDate; d = addDaysIso(d, 1)) {
    for (const entry of occupancyIndex.get(occupancyKey(bedId, d)) ?? []) {
      if (entry.id !== excludeBookingId) conflicts.set(entry.id, entry);
    }
  }
  return [...conflicts.values()];
}

export default function GridCanvas({ initialData, today }: { initialData: GridData; today: ISODate }) {
  const router = useRouter();
  const epochStart = useMemo(() => addDays(today, -365 * YEARS_BACK), [today]);
  const totalColumns = 365 * (YEARS_BACK + YEARS_FORWARD);

  const [data, setData] = useState<GridData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jumpValue, setJumpValue] = useState(today);
  const fetchTokenRef = useRef(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  const dataStartIndex = useMemo(() => nightsBetween(epochStart, data.start), [epochStart, data.start]);

  const virtualizer = useVirtualizer({
    count: totalColumns,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => COLUMN_WIDTH,
    horizontal: true,
    overscan: 6,
  });

  // `virtualizer.scrollToIndex` writes scrollLeft imperatively; the
  // virtualizer doesn't recompute `getVirtualItems()` for that until the
  // NEXT render. Any effect that reads virtualColumns right after a scroll
  // (e.g. the "grow loaded window" effect below) would otherwise see a
  // stale, pre-scroll column range and think it's miles from the loaded
  // data — this gate holds that effect off until the scroll has actually
  // landed and React has re-rendered with the fresh positions.
  const settledRef = useRef(false);
  const [scrollGeneration, setScrollGeneration] = useState(0);

  const scrollToIndexSettled = useCallback(
    (index: number) => {
      settledRef.current = false;
      virtualizer.scrollToIndex(index, { align: "start" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          settledRef.current = true;
          setScrollGeneration((g) => g + 1);
        });
      });
    },
    [virtualizer]
  );

  // Scroll to "today" on first mount.
  useEffect(() => {
    scrollToIndexSettled(nightsBetween(epochStart, today));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchWindow(start: ISODate, days: number) {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/grid?start=${start}&days=${days}`);
      if (!res.ok) throw new Error("Could not load the grid for that range.");
      const json: GridData = await res.json();
      if (fetchTokenRef.current === token) setData(json);
    } catch {
      if (fetchTokenRef.current === token) setError("Could not load the grid for that range.");
    } finally {
      if (fetchTokenRef.current === token) setLoading(false);
    }
  }

  const virtualColumns = virtualizer.getVirtualItems();

  // Shift the loaded window as the visible range approaches its edge —
  // fetch the next ~60-day stretch centered on what's currently visible and
  // drop the far side, rather than growing the window without bound.
  //
  // Recentering (not nudging by just the buffer amount) matters: a nudge
  // that trims the margin down to exactly EDGE_BUFFER_DAYS on the side that
  // triggered can leave the OTHER side just as thin, which re-triggers a
  // shift back the moment the fetch resolves — an infinite ping-pong
  // between two windows. Recentering maximises the margin on both sides
  // after every shift, and is self-limiting: once centered, re-running this
  // with an unchanged visible range recomputes the same window and the
  // no-op guard below stops it.
  useEffect(() => {
    if (!settledRef.current || loading || virtualColumns.length === 0) return;
    const visibleStart = virtualColumns[0].index;
    const visibleEnd = virtualColumns[virtualColumns.length - 1].index;
    const loadedEnd = dataStartIndex + data.days;

    const nearLeftEdge = visibleStart - dataStartIndex < EDGE_BUFFER_DAYS;
    const nearRightEdge = loadedEnd - visibleEnd < EDGE_BUFFER_DAYS;
    if (!nearLeftEdge && !nearRightEdge) return;

    const visibleCenter = Math.floor((visibleStart + visibleEnd) / 2);
    let newStartIndex = Math.max(0, visibleCenter - Math.floor(ROLLING_WINDOW_DAYS / 2));
    const newEndIndex = Math.min(totalColumns, newStartIndex + ROLLING_WINDOW_DAYS);
    newStartIndex = Math.max(0, newEndIndex - ROLLING_WINDOW_DAYS);
    const newDays = newEndIndex - newStartIndex;
    if (newStartIndex === dataStartIndex && newDays === data.days) return;

    fetchWindow(addDays(epochStart, newStartIndex), newDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualColumns.map((c) => c.index).join(","), loading, scrollGeneration]);

  async function jumpToDate(dateStr: ISODate) {
    const targetIndex = nightsBetween(epochStart, dateStr);
    if (targetIndex < 0 || targetIndex >= totalColumns) {
      setError("That date is outside the range this grid supports.");
      return;
    }
    if (targetIndex < dataStartIndex || targetIndex >= dataStartIndex + data.days) {
      const newStart = addDays(dateStr, -Math.floor(ROLLING_WINDOW_DAYS / 2));
      await fetchWindow(newStart, ROLLING_WINDOW_DAYS);
    }
    scrollToIndexSettled(targetIndex);
  }

  // --- Drag-to-pan (both axes), disambiguated from clicks -------------------

  const dragRef = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [panning, setPanning] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const vp = viewportRef.current;
    if (!vp) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, scrollLeft: vp.scrollLeft, scrollTop: vp.scrollTop, dragging: false };
    vp.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragRef.current;
    const vp = viewportRef.current;
    if (!ds || !vp) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (!ds.dragging && Math.hypot(dx, dy) > 5) {
      ds.dragging = true;
      setPanning(true);
    }
    if (ds.dragging) {
      e.preventDefault();
      vp.scrollLeft = ds.scrollLeft - dx;
      vp.scrollTop = ds.scrollTop - dy;
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragRef.current;
    if (ds?.dragging) {
      suppressClickRef.current = true;
      setPanning(false);
    }
    dragRef.current = null;
    viewportRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClickRef.current = false;
    }
  }, []);

  // Belt-and-suspenders for the booking-pill drag (see onPillPointerDown /
  // clearPillDragVisuals): the pill's own onPointerUp/onPointerCancel handle
  // the normal case, but if pointer capture is ever lost some other way
  // (window loses focus mid-drag, browser quirk) those never fire on the
  // pill itself, leaving the green drop-target outline and dimmed pill
  // stuck until a refresh. These window-level listeners are a global
  // fallback that always runs, regardless of what element has capture.
  useEffect(() => {
    window.addEventListener("pointerup", clearPillDragVisuals);
    window.addEventListener("pointercancel", clearPillDragVisuals);
    window.addEventListener("blur", clearPillDragVisuals);
    window.addEventListener("pointerup", clearEventDragVisuals);
    window.addEventListener("pointercancel", clearEventDragVisuals);
    window.addEventListener("blur", clearEventDragVisuals);
    return () => {
      window.removeEventListener("pointerup", clearPillDragVisuals);
      window.removeEventListener("pointercancel", clearPillDragVisuals);
      window.removeEventListener("blur", clearPillDragVisuals);
      window.removeEventListener("pointerup", clearEventDragVisuals);
      window.removeEventListener("pointercancel", clearEventDragVisuals);
      window.removeEventListener("blur", clearEventDragVisuals);
    };
  }, []);

  // Kept in sync with the loaded grid so the drag collision check (see
  // conflictingBookings) always answers against the current data, not a
  // stale snapshot from when the drag started.
  useEffect(() => {
    occupancyIndex = buildOccupancyIndex(data.grid, data.dates);
    bedCapacityIndex = buildBedCapacityIndex(data.grid);
  }, [data]);

  // --- Toasts -----------------------------------------------------------

  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  function pushToast(text: string) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // --- Auto-allocate (manual, from the "Needs a bed" panel) --------------

  const [autoAllocating, setAutoAllocating] = useState(false);

  async function runAutoAllocate() {
    setAutoAllocating(true);
    try {
      const res = await fetch("/api/bookings/auto-allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ withinDays: 7 }),
      });
      if (!res.ok) {
        pushToast("Could not auto-allocate — please try again.");
        return;
      }
      const body: { assigned: { guestName: string }[]; skipped: { guestName: string; reason: string }[] } = await res.json();
      const parts = [`Assigned ${body.assigned.length} booking${body.assigned.length === 1 ? "" : "s"}`];
      if (body.skipped.length > 0) parts.push(`${body.skipped.length} still need${body.skipped.length === 1 ? "s" : ""} a bed`);
      pushToast(parts.join(", ") + ".");
      await fetchWindow(data.start, data.days);
    } finally {
      setAutoAllocating(false);
    }
  }

  function notifyUnassigned(unassignedBookings: UnassignedBooking[] | undefined) {
    if (!unassignedBookings || unassignedBookings.length === 0) return;
    const names = unassignedBookings.map((b) => `${b.guestName} (${formatDateUk(b.arrivalDate)} to ${formatDateUk(b.departureDate)})`).join(", ");
    pushToast(
      `This layout change conflicts with ${unassignedBookings.length} existing booking${unassignedBookings.length === 1 ? "" : "s"} — moved to unallocated: ${names}`
    );
  }

  // --- Right-click lifecycle: join / switch / split ----------------------

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [bedActionModal, setBedActionModal] = useState<BedActionModalState | null>(null);
  const [joinActionModal, setJoinActionModal] = useState<JoinActionModalState | null>(null);
  const [joinConflictModal, setJoinConflictModal] = useState<
    (JoinConflictModalState & { retry: (resolution: "overwrite" | "trim") => Promise<boolean> }) | null
  >(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);

  function openMenu(e: React.MouseEvent, title: string, items: ContextMenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, title, items });
  }

  async function apiPost<T = { unassignedBookings?: UnassignedBooking[] }>(url: string, body: unknown): Promise<T | null> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return null;
    }
    return res.json();
  }

  async function apiPatch(url: string, body: unknown): Promise<boolean> {
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return false;
    }
    return true;
  }

  async function apiDelete(url: string): Promise<boolean> {
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return false;
    }
    return true;
  }

  async function refreshCurrentWindow() {
    await fetchWindow(data.start, data.days);
  }

  // --- Undo/Redo -----------------------------------------------------------
  //
  // Every action below that mutates the schedule pushes a HistoryEntry whose
  // undo/redo call the low-level apiPost/apiPatch/apiDelete helpers DIRECTLY
  // — never `actions.*` itself, which would push a NEW history entry for the
  // undo and corrupt the stack. Each entry carries the exact reverse payload
  // (old bed id, old dates, a full booking snapshot, …) captured at the
  // moment the action ran, not re-derived later from whatever the grid
  // happens to show — that's what keeps undo correct even several steps
  // back. moveBed's reverse re-places the bed in its previous room as of
  // the SAME effective date (see BedActionModalState.previousRoomId,
  // captured at the moment the modal opens) — correct for the common case
  // of undoing immediately after, though not a full point-in-time history
  // reconstruction if other bed_locations changes happened in between.
  interface HistoryEntry {
    id: number;
    label: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }

  const MAX_HISTORY = 20;
  const [historyPast, setHistoryPast] = useState<HistoryEntry[]>([]);
  const [historyFuture, setHistoryFuture] = useState<HistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyIdRef = useRef(0);

  function pushHistory(entry: Omit<HistoryEntry, "id">) {
    const full: HistoryEntry = { id: historyIdRef.current++, ...entry };
    setHistoryPast((prev) => {
      const next = [...prev, full];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setHistoryFuture([]);
  }

  async function undo() {
    if (historyBusy || historyPast.length === 0) return;
    const entry = historyPast[historyPast.length - 1];
    setHistoryBusy(true);
    setHistoryPast((prev) => prev.slice(0, -1));
    try {
      await entry.undo();
    } finally {
      setHistoryFuture((prev) => [...prev, entry]);
      setHistoryBusy(false);
    }
  }

  async function redo() {
    if (historyBusy || historyFuture.length === 0) return;
    const entry = historyFuture[historyFuture.length - 1];
    setHistoryBusy(true);
    setHistoryFuture((prev) => prev.slice(0, -1));
    try {
      await entry.redo();
    } finally {
      setHistoryPast((prev) => [...prev, entry]);
      setHistoryBusy(false);
    }
  }

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z to redo — skipped
  // while focus is in a text field (the "Jump to" date input, any future
  // form field) so it doesn't fight normal text editing/selection.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyPast, historyFuture, historyBusy]);

  const actions = useMemo(
    () => ({
      openMenu,
      async joinAsNew(
        bed1Id: number,
        bed2Id: number,
        mode: "double" | "solo",
        startDate: ISODate,
        endDate: ISODate | null,
        resolution?: "overwrite" | "trim"
      ) {
        // Raw fetch (not apiPost) — a 409 here carries a structured
        // `conflict`/`futureConflict` payload (see POST /api/joined-beds)
        // that needs its own handling, not the generic error banner every
        // other action falls back to.
        const res = await fetch("/api/joined-beds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bed1Id, bed2Id, mode, startDate, endDate, resolution }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (body.futureConflict) {
            // A GENUINE future collision for this exact bed pair — ask the
            // user to choose rather than silently trimming (see
            // JoinConflictModal). Re-invokes this same action with the
            // chosen resolution once they pick.
            const futureConflict = body.futureConflict as { startDate: ISODate };
            setJoinConflictModal({
              conflictStartDate: futureConflict.startDate,
              retry: (chosen) => actions.joinAsNew(bed1Id, bed2Id, mode, startDate, endDate, chosen),
            });
          } else if (body.conflict) {
            const conflict = body.conflict as { startDate: ISODate; endDate: ISODate | null };
            pushToast(
              `Conflict: Already joined from ${formatDateUk(conflict.startDate)} to ${conflict.endDate ? formatDateUk(conflict.endDate) : "indefinitely"}`
            );
          } else {
            setError(body.error ?? "Something went wrong.");
          }
          return false;
        }
        notifyUnassigned(body.unassignedBookings);
        // With no explicit resolution requested (no prior collision), the
        // server may still have silently trimmed the end date against a
        // DIFFERENT-partner conflict — that path is unchanged/out of scope,
        // so still surface it here.
        if (!resolution && (endDate ?? null) !== (body.endDate ?? null) && body.endDate) {
          pushToast(`Joined ${formatDateUk(startDate)} onward — trimmed to end ${formatDateUk(body.endDate)}, right before an existing later join.`);
        }
        await refreshCurrentWindow();
        let currentJoinId: number | undefined = body.id;
        const overwrittenJoin = body.overwrittenJoin as
          | { bed1Id: number; bed2Id: number; startDate: ISODate; endDate: ISODate | null; mode: "double" | "solo" }
          | null
          | undefined;
        pushHistory({
          label: `Join beds as ${mode === "solo" ? "Solo" : "Couple"} Double`,
          undo: async () => {
            if (currentJoinId != null) await apiDelete(`/api/joined-beds/${currentJoinId}`);
            // Overwriting deleted a future join for these same beds outright
            // — undo must bring it back exactly as it was, not just remove
            // the new one, or that scheduled join silently vanishes.
            if (overwrittenJoin) {
              await apiPost("/api/joined-beds", {
                bed1Id: overwrittenJoin.bed1Id,
                bed2Id: overwrittenJoin.bed2Id,
                mode: overwrittenJoin.mode,
                startDate: overwrittenJoin.startDate,
                endDate: overwrittenJoin.endDate,
              });
            }
            await refreshCurrentWindow();
          },
          redo: async () => {
            const r = await apiPost<{ id: number }>("/api/joined-beds", { bed1Id, bed2Id, mode, startDate, endDate, resolution });
            currentJoinId = r?.id;
            await refreshCurrentWindow();
          },
        });
        return true;
      },
      async switchJoinMode(bed1Id: number, bed2Id: number, atDate: ISODate, mode: "double" | "solo") {
        const oldMode: "double" | "solo" = mode === "double" ? "solo" : "double";
        const result = await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode });
        if (!result) return;
        notifyUnassigned(result.unassignedBookings);
        await refreshCurrentWindow();
        pushHistory({
          label: `Switch to ${mode === "double" ? "Couple" : "Solo"} Double`,
          undo: async () => {
            await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode: oldMode });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode });
            await refreshCurrentWindow();
          },
        });
      },
      async splitJoin(bed1Id: number, bed2Id: number, atDate: ISODate) {
        // Capture the exact segment being split BEFORE splitting it, so undo
        // can recreate it precisely (not just "a" join, THIS join's dates/mode).
        const listRes = await fetch("/api/joined-beds");
        const list: Array<{ bed1Id: number; bed2Id: number; startDate: ISODate; endDate: ISODate | null; mode: "double" | "solo" }> =
          listRes.ok ? await listRes.json() : [];
        const active = list.find(
          (j) =>
            ((j.bed1Id === bed1Id && j.bed2Id === bed2Id) || (j.bed1Id === bed2Id && j.bed2Id === bed1Id)) &&
            j.startDate <= atDate &&
            (j.endDate == null || j.endDate > atDate)
        );

        const result = await apiPost("/api/joined-beds/split", { bed1Id, bed2Id, atDate });
        if (!result) return;
        await refreshCurrentWindow();
        if (!active) return;
        pushHistory({
          label: "Split into Singles",
          undo: async () => {
            await apiPost("/api/joined-beds", {
              bed1Id: active.bed1Id,
              bed2Id: active.bed2Id,
              mode: active.mode,
              startDate: active.startDate,
              endDate: active.endDate,
            });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/joined-beds/split", { bed1Id, bed2Id, atDate });
            await refreshCurrentWindow();
          },
        });
      },
      async goSolo(bedId: number, atDate: ISODate) {
        const result = await apiPost("/api/bed-solo-periods", { bedId, startDate: atDate });
        if (!result) return;
        notifyUnassigned(result.unassignedBookings);
        await refreshCurrentWindow();
        pushHistory({
          label: "Switch to Solo",
          undo: async () => {
            await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bed-solo-periods", { bedId, startDate: atDate });
            await refreshCurrentWindow();
          },
        });
      },
      async goCouple(bedId: number, atDate: ISODate) {
        const listRes = await fetch("/api/bed-solo-periods");
        const list: Array<{ bedId: number; startDate: ISODate; endDate: ISODate | null }> = listRes.ok ? await listRes.json() : [];
        const active = list.find((p) => p.bedId === bedId && p.startDate <= atDate && (p.endDate == null || p.endDate > atDate));

        const result = await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
        if (!result) return;
        await refreshCurrentWindow();
        if (!active) return;
        pushHistory({
          label: "Switch to Couple",
          undo: async () => {
            await apiPost("/api/bed-solo-periods", { bedId, startDate: active.startDate, endDate: active.endDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
            await refreshCurrentWindow();
          },
        });
      },
      // Confirmation happens in the caller (see bookingCellMenuItems' Delete
      // Booking item, which opens ConfirmModal before this ever runs) —
      // this only does the actual delete + undo/redo bookkeeping.
      async cancelBooking(bookingId: number, guestName: string) {
        const snapshotRes = await fetch(`/api/bookings/${bookingId}`);
        const snapshot = snapshotRes.ok ? await snapshotRes.json() : null;
        if (!(await apiDelete(`/api/bookings/${bookingId}`))) return;
        await refreshCurrentWindow();
        if (!snapshot) return;
        // Recreating on undo gets a NEW row id — this closure variable (not
        // the original bookingId) is what redo/a later undo must target.
        let currentId = bookingId;
        pushHistory({
          label: `Delete ${guestName}'s booking`,
          undo: async () => {
            const res = await fetch("/api/bookings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                guestName: snapshot.guestName,
                arrivalDate: snapshot.arrivalDate,
                departureDate: snapshot.departureDate,
                linkedBookingId: snapshot.linkedBookingId,
                bedId: snapshot.bedId,
                dietariesTags: snapshot.dietariesTags,
              }),
            });
            if (res.ok) currentId = (await res.json()).id;
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiDelete(`/api/bookings/${currentId}`);
            await refreshCurrentWindow();
          },
        });
      },
      async splitBooking(bookingId: number, splitDate: ISODate, guestName: string, originalDeparture: ISODate) {
        const result = await apiPost<{ updated: { id: number }; created: { id: number } }>(
          `/api/bookings/${bookingId}/split`,
          { splitDate }
        );
        if (!result) return;
        await refreshCurrentWindow();
        // Recreating on redo gets a NEW row id — this closure variable (not
        // the id from the first split) is what undo/a later redo must target.
        let currentNewId = result.created.id;
        pushHistory({
          label: `Split ${guestName}'s booking on ${formatDateUk(splitDate)}`,
          undo: async () => {
            await apiDelete(`/api/bookings/${currentNewId}`);
            await apiPatch(`/api/bookings/${bookingId}`, { departureDate: originalDeparture });
            await refreshCurrentWindow();
          },
          redo: async () => {
            const r = await apiPost<{ updated: { id: number }; created: { id: number } }>(
              `/api/bookings/${bookingId}/split`,
              { splitDate }
            );
            if (r) currentNewId = r.created.id;
            await refreshCurrentWindow();
          },
        });
      },
      async mergeBookings(departingBookingId: number, arrivingBookingId: number, guestName: string) {
        const result = await apiPost<{
          updated: { id: number; departureDate: ISODate };
          deletedSnapshot: {
            id: number;
            guestName: string;
            arrivalDate: ISODate;
            departureDate: ISODate;
            linkedBookingId: number | null;
            bedId: number | null;
            dietariesTags: unknown;
          };
        }>(`/api/bookings/${departingBookingId}/merge`, { otherBookingId: arrivingBookingId });
        if (!result) return;
        await refreshCurrentWindow();
        // The reverse of splitBooking: the earlier (departing) booking
        // keeps its own id and absorbs the later one's dates; the later
        // booking is deleted. `splitPoint` (the deleted booking's own
        // arrivalDate) is exactly what the earlier booking's departureDate
        // was BEFORE this merge, since they were required to be
        // back-to-back — that's what undo reverts it to.
        const keptId = result.updated.id;
        const splitPoint = result.deletedSnapshot.arrivalDate;
        // Recreating on undo gets a NEW row id — this closure variable is
        // what a later redo must target.
        let currentLaterId: number | undefined;
        pushHistory({
          label: `Merge ${guestName}'s bookings`,
          undo: async () => {
            await apiPatch(`/api/bookings/${keptId}`, { departureDate: splitPoint });
            const res = await fetch("/api/bookings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                guestName: result.deletedSnapshot.guestName,
                arrivalDate: result.deletedSnapshot.arrivalDate,
                departureDate: result.deletedSnapshot.departureDate,
                linkedBookingId: result.deletedSnapshot.linkedBookingId,
                bedId: result.deletedSnapshot.bedId,
                dietariesTags: result.deletedSnapshot.dietariesTags,
              }),
            });
            if (res.ok) currentLaterId = (await res.json()).id;
            await refreshCurrentWindow();
          },
          redo: async () => {
            if (currentLaterId == null) return;
            await apiPost(`/api/bookings/${keptId}/merge`, { otherBookingId: currentLaterId });
            await refreshCurrentWindow();
          },
        });
      },
      async moveBooking(
        bookingId: number,
        to: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
        from: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
        guestName: string
      ) {
        if (!(await apiPatch(`/api/bookings/${bookingId}`, to))) return;
        await refreshCurrentWindow();
        pushHistory({
          label: `Move ${guestName}`,
          undo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, from);
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, to);
            await refreshCurrentWindow();
          },
        });
      },
      async resizeBookingDates(
        bookingId: number,
        field: "arrivalDate" | "departureDate",
        fromValue: ISODate,
        toValue: ISODate,
        guestName: string
      ) {
        if (!(await apiPatch(`/api/bookings/${bookingId}`, { [field]: toValue }))) return;
        await refreshCurrentWindow();
        pushHistory({
          label: `Resize ${guestName}`,
          undo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, { [field]: fromValue });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, { [field]: toValue });
            await refreshCurrentWindow();
          },
        });
      },
      async swapBookings(params: {
        draggedBookingId: number;
        otherBookingId: number;
        fromBedId: number;
        toBedId: number;
        draggedFrom: { arrivalDate: ISODate; departureDate: ISODate };
        draggedTo: { arrivalDate: ISODate; departureDate: ISODate };
        draggedName: string;
        otherName: string;
      }) {
        const { draggedBookingId, otherBookingId, fromBedId, toBedId, draggedFrom, draggedTo, draggedName, otherName } = params;
        // The dragged booking takes its (possibly date-shifted) new spot;
        // the displaced booking goes back to the origin bed with ITS OWN
        // dates untouched — that's the swap this pair is offered for in the
        // first place (see the reciprocity check in onPillPointerMove),
        // never a date change for the booking being evicted. One atomic
        // request (not two sequential PATCHes) — see /api/bookings/swap:
        // a naive two-call sequence can't be capacity-checked safely, since
        // at the instant the first call lands the other booking is still
        // sitting in the bed it's trading away.
        const ok = await apiPost("/api/bookings/swap", {
          draggedBookingId,
          otherBookingId,
          fromBedId,
          toBedId,
          draggedArrival: draggedTo.arrivalDate,
          draggedDeparture: draggedTo.departureDate,
        });
        if (!ok) return;
        await refreshCurrentWindow();
        pushToast(`Swapped ${draggedName} and ${otherName}`);
        pushHistory({
          label: `Swap ${draggedName} and ${otherName}`,
          undo: async () => {
            await apiPost("/api/bookings/swap", {
              draggedBookingId,
              otherBookingId,
              fromBedId: toBedId,
              toBedId: fromBedId,
              draggedArrival: draggedFrom.arrivalDate,
              draggedDeparture: draggedFrom.departureDate,
            });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bookings/swap", {
              draggedBookingId,
              otherBookingId,
              fromBedId,
              toBedId,
              draggedArrival: draggedTo.arrivalDate,
              draggedDeparture: draggedTo.departureDate,
            });
            await refreshCurrentWindow();
          },
        });
      },
      async moveEvent(
        eventId: number,
        name: string,
        notes: string | null,
        to: { startDate: ISODate; endDate: ISODate },
        from: { startDate: ISODate; endDate: ISODate }
      ) {
        const patch = { name, notes, startDate: to.startDate, endDate: to.endDate };
        if (!(await apiPatch(`/api/events/${eventId}`, patch))) return;
        await refreshCurrentWindow();
        pushHistory({
          label: `Move ${name}`,
          undo: async () => {
            await apiPatch(`/api/events/${eventId}`, { name, notes, startDate: from.startDate, endDate: from.endDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPatch(`/api/events/${eventId}`, patch);
            await refreshCurrentWindow();
          },
        });
      },
      async moveBed(bedId: number, roomId: number, startDate: ISODate, previousRoomId: number) {
        const result = await apiPost("/api/bed-locations", { bedId, roomId, startDate });
        if (!result) return;
        await refreshCurrentWindow();
        if (previousRoomId === roomId) return; // dropped back where it started — nothing to undo
        pushHistory({
          label: "Move Bed",
          undo: async () => {
            // Same effective date, previous room — POST's own truncate logic
            // (see /api/bed-locations) then puts the bed back exactly where
            // it was as of that date, the same way the forward move worked.
            await apiPost("/api/bed-locations", { bedId, roomId: previousRoomId, startDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bed-locations", { bedId, roomId, startDate });
            await refreshCurrentWindow();
          },
        });
      },
      openBedActionModal: setBedActionModal,
      openJoinActionModal: setJoinActionModal,
      openConfirmModal: setConfirmModal,
      navigate: (url: string) => router.push(url),
      dormStorageRoomId: data.dormStorageRoomId,
      today,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.start, data.days, data.dormStorageRoomId, today, router]
  );

  // --- Visible-column geometry, shared by every row -------------------------

  const leadingWidth = virtualColumns[0]?.start ?? 0;
  const trailingWidth = virtualColumns.length > 0 ? virtualizer.getTotalSize() - virtualColumns[virtualColumns.length - 1].end : 0;

  const visibleColumns: VisibleColumn[] = virtualColumns.map((vc) => {
    const date = addDays(epochStart, vc.index);
    const dataIndex = vc.index - dataStartIndex;
    return { globalIndex: vc.index, date, dataIndex: dataIndex >= 0 && dataIndex < data.days ? dataIndex : null };
  });

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Grid</h1>
        {loading ? (
          <span className="tr-muted" style={{ fontSize: 12 }}>Loading…</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={undo}
          disabled={historyPast.length === 0 || historyBusy}
          title={historyPast.length > 0 ? `Undo: ${historyPast[historyPast.length - 1].label} (Ctrl+Z)` : "Nothing to undo"}
          aria-label="Undo"
        >
          ↶ Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={historyFuture.length === 0 || historyBusy}
          title={historyFuture.length > 0 ? `Redo: ${historyFuture[historyFuture.length - 1].label} (Ctrl+Y)` : "Nothing to redo"}
          aria-label="Redo"
        >
          ↷ Redo
        </button>
        <button type="button" onClick={() => jumpToDate(today)}>Today</button>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          Jump to
          <DateField value={jumpValue} onChange={setJumpValue} />
        </label>
        <button type="button" className="primary" onClick={() => jumpToDate(jumpValue)}>Go</button>
      </div>

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 10 }}>{error}</p>}

      {data.grid.length === 0 && (
        <p className="tr-muted" style={{ marginBottom: 12 }}>
          No beds are placed in any room during this date range. Add floors, rooms and beds, then place beds in{" "}
          <a href="/settings/layout">Property Layout</a>.
        </p>
      )}

      <div
        ref={viewportRef}
        className={`tr-grid-viewport${panning ? " tr-grid-panning" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <table className="tr-grid" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th className="tr-grid-room" style={{ left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH }}>Room</th>
              <th className="tr-grid-bed" style={{ left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH }}>Bed</th>
              {leadingWidth > 0 && <th style={{ width: leadingWidth, minWidth: leadingWidth }} />}
              {visibleColumns.map((col) => (
                <th
                  key={col.globalIndex}
                  className={isWeekend(col.date) ? "tr-grid-weekend" : undefined}
                  style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }}
                >
                  <div>{weekday(col.date)}</div>
                  <div style={{ fontWeight: 400 }}>{formatDateUk(col.date).slice(0, 5)}</div>
                </th>
              ))}
              {trailingWidth > 0 && <th style={{ width: trailingWidth, minWidth: trailingWidth }} />}
            </tr>
          </thead>
          <tbody>
            {data.eventLanes.map((lane, laneIndex) => (
              <tr key={`event-lane-${laneIndex}`} className="tr-grid-event-lane">
                <td className="tr-grid-room tr-grid-event-head" style={{ left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH }}>
                  {laneIndex === 0 ? "Events" : ""}
                </td>
                <td className="tr-grid-bed" style={{ left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH }} />
                {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
                {renderEventLaneCells(lane, visibleColumns, dataStartIndex, actions)}
                {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
              </tr>
            ))}

            {data.grid.map((room, roomIndex) =>
              renderRoomRows(room, roomIndex, visibleColumns, leadingWidth, trailingWidth, actions)
            )}

            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={{ left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH }}>Bed Occupancy</td>
              <td className="tr-grid-bed" style={{ left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH }} />
              {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
              {visibleColumns.map((col) => {
                const occ = col.dataIndex != null ? data.occupiedByDate[col.dataIndex] : null;
                const tot = col.dataIndex != null ? data.totalByDate[col.dataIndex] : null;
                return (
                  <td key={col.globalIndex} className={occ != null && tot != null && occ > tot ? "tr-badge-warn" : undefined}>
                    {occ != null && tot != null ? `${occ}/${tot}` : ""}
                  </td>
                );
              })}
              {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
            </tr>
            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={{ left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH }}>Arrivals</td>
              <td className="tr-grid-bed" style={{ left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH }} />
              {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
              {visibleColumns.map((col) => (
                <td key={col.globalIndex}>{col.dataIndex != null ? data.arrByDate[col.dataIndex] || "" : ""}</td>
              ))}
              {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
            </tr>
            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={{ left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH }}>Departures</td>
              <td className="tr-grid-bed" style={{ left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH }} />
              {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
              {visibleColumns.map((col) => (
                <td key={col.globalIndex}>{col.dataIndex != null ? data.depByDate[col.dataIndex] || "" : ""}</td>
              ))}
              {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="tr-muted" style={{ fontSize: 12, marginTop: 8 }}>
        Drag anywhere on the grid to pan. Double-click a free cell to start a new booking, or a booking to edit it.
        Right-click a booking to cancel it. Drag a booking&apos;s middle to move it to a different bed, or its edge to
        change dates. Click or right-click a bed&apos;s name to move it, join it, or send it to Dorm Storage. Beds in
        Dorm Storage are greyed out and don&apos;t count toward capacity.
      </p>

      {data.alerts.length > 0 && (
        <div className="tr-grid-alerts-corner">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ fontWeight: 700 }}>Needs a bed ({data.alerts.length})</div>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={runAutoAllocate} disabled={autoAllocating} style={{ minHeight: "unset", padding: "3px 8px", fontSize: 12 }}>
              {autoAllocating ? "Allocating…" : "Auto-allocate next 7 days"}
            </button>
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {data.alerts.slice(0, 12).map((a) => (
              <li key={a.id} style={{ marginBottom: 4 }}>
                <a href={`/bookings/${a.id}`}>{a.guestName}</a> ({formatDateUk(a.arrivalDate)} to {formatDateUk(a.departureDate)})
              </li>
            ))}
          </ul>
          {data.alerts.length > 12 && (
            <div className="tr-muted" style={{ marginTop: 6, fontSize: 12 }}>
              +{data.alerts.length - 12} more
            </div>
          )}
        </div>
      )}

      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
      <BedActionModal
        state={bedActionModal}
        dormStorageRoomId={data.dormStorageRoomId}
        onClose={() => setBedActionModal(null)}
        onSubmit={async (bedId, roomId, startDate, previousRoomId) => {
          await actions.moveBed(bedId, roomId, startDate, previousRoomId);
          setBedActionModal(null);
        }}
      />
      <JoinActionModal
        state={joinActionModal}
        onClose={() => setJoinActionModal(null)}
        onSubmit={async (startDate, endDate) => {
          if (!joinActionModal) return false;
          const ok = await actions.joinAsNew(joinActionModal.bed1Id, joinActionModal.bed2Id, joinActionModal.mode, startDate, endDate);
          if (ok) setJoinActionModal(null);
          return ok;
        }}
      />
      <JoinConflictModal
        state={joinConflictModal}
        onClose={() => setJoinConflictModal(null)}
        onResolve={async (resolution) => {
          if (!joinConflictModal) return;
          const ok = await joinConflictModal.retry(resolution);
          if (ok) setJoinConflictModal(null);
        }}
      />
      <ConfirmModal state={confirmModal} onClose={() => setConfirmModal(null)} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

// ---------------------------------------------------------------------------

const ROOM_CELL_STYLE = { left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH };
const BED_CELL_STYLE = { left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH };

// A bed parked in Dorm Storage is off active duty (see rooms.excludeFromCapacity)
// — every row for that room gets a fixed grey tint instead of the per-room
// palette cycle in roomColourStyle, plus .tr-grid-room-storage for dimmed
// text, so it reads as "greyed out" at a glance rather than just another
// room colour in the rotation. Deliberately background-COLOUR only, never
// `opacity`/`filter` on the <tr> — the Room/Bed label cells in this row are
// `position: sticky`, and opacity on an ancestor of a sticky element forces
// an isolated compositing layer that visibly seams/bleeds at the sticky
// element's edges as it scrolls (that's the "hatching bleeds over
// text/borders" bug), and would ALSO have flattened the weekend gradient
// and this tint into one layer before dimming instead of leaving them as
// independent, normally-composited background layers.
const DORM_STORAGE_ROOM_STYLE: React.CSSProperties = {
  ["--tr-room-tint" as string]: "#dbd7cd",
  ["--tr-room-label" as string]: "#c7c2b4",
} as React.CSSProperties;

function roomTrStyle(room: RoomGridRow, roomIndex: number): React.CSSProperties {
  return room.excludeFromCapacity ? DORM_STORAGE_ROOM_STYLE : roomColourStyle(roomIndex);
}

function roomTrClassName(isFirstRoomRow: boolean, room: RoomGridRow): string | undefined {
  const classes: string[] = [];
  if (isFirstRoomRow) classes.push("tr-grid-room-start");
  if (room.excludeFromCapacity) classes.push("tr-grid-room-storage");
  return classes.length > 0 ? classes.join(" ") : undefined;
}

/**
 * Clicking or right-clicking a bed's own label (the left sidebar, not a date
 * cell) opens: whatever join/switch/split options apply to that bed today
 * (if any — plain unjoinable beds get none), then always "Move Bed" and
 * "Send to Dorm Storage". `joinMenu` is the same menu object already built
 * per date column in renderPairedBlock/renderNativePairBlock — see
 * `representativeMenu` there — so this never re-derives join state itself.
 */
function bedLabelMenu(
  bedId: number,
  bedLabel: string,
  room: RoomGridRow,
  actions: GridActions,
  joinMenu?: { title: string; items: ContextMenuItem[] }
): { title: string; items: ContextMenuItem[] } {
  const items: ContextMenuItem[] = [...(joinMenu?.items ?? [])];
  items.push({
    label: "Move Bed",
    onClick: () => actions.openBedActionModal({ mode: "move", bedId, bedLabel, defaultDate: actions.today, previousRoomId: room.roomId }),
  });
  if (!room.excludeFromCapacity) {
    items.push({
      label: "Send to Dorm Storage",
      danger: true,
      onClick: () => actions.openBedActionModal({ mode: "storage", bedId, bedLabel, defaultDate: actions.today, previousRoomId: room.roomId }),
    });
  }
  return { title: joinMenu?.title ?? `${room.roomName} — ${bedLabel}`, items };
}

function bedLabelHandlers(
  bedId: number,
  bedLabel: string,
  room: RoomGridRow,
  actions: GridActions,
  joinMenu?: { title: string; items: ContextMenuItem[] }
) {
  const open = (e: React.MouseEvent) => {
    const menu = bedLabelMenu(bedId, bedLabel, room, actions, joinMenu);
    actions.openMenu(e, menu.title, menu.items);
  };
  return { onClick: open, onContextMenu: open };
}

type VisibleColumn = { globalIndex: number; date: ISODate; dataIndex: number | null };
type SlotCell = import("@/lib/grid").SlotCell;
type GridUnit = import("@/lib/grid").GridUnit;
type RoomGridRow = import("@/lib/grid").RoomGridRow;
type GridBooking = import("@/lib/grid").GridBooking;

interface GridActions {
  openMenu: (e: React.MouseEvent, title: string, items: ContextMenuItem[]) => void;
  joinAsNew: (
    bed1Id: number,
    bed2Id: number,
    mode: "double" | "solo",
    startDate: ISODate,
    endDate: ISODate | null,
    resolution?: "overwrite" | "trim"
  ) => Promise<boolean>;
  switchJoinMode: (bed1Id: number, bed2Id: number, atDate: ISODate, mode: "double" | "solo") => void;
  splitJoin: (bed1Id: number, bed2Id: number, atDate: ISODate) => void;
  goSolo: (bedId: number, atDate: ISODate) => void;
  goCouple: (bedId: number, atDate: ISODate) => void;
  cancelBooking: (bookingId: number, guestName: string) => void;
  splitBooking: (bookingId: number, splitDate: ISODate, guestName: string, originalDeparture: ISODate) => void;
  mergeBookings: (departingBookingId: number, arrivingBookingId: number, guestName: string) => void;
  moveBooking: (
    bookingId: number,
    to: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
    from: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
    guestName: string
  ) => void;
  resizeBookingDates: (
    bookingId: number,
    field: "arrivalDate" | "departureDate",
    fromValue: ISODate,
    toValue: ISODate,
    guestName: string
  ) => void;
  swapBookings: (params: {
    draggedBookingId: number;
    otherBookingId: number;
    fromBedId: number;
    toBedId: number;
    draggedFrom: { arrivalDate: ISODate; departureDate: ISODate };
    draggedTo: { arrivalDate: ISODate; departureDate: ISODate };
    draggedName: string;
    otherName: string;
  }) => void;
  moveBed: (bedId: number, roomId: number, startDate: ISODate, previousRoomId: number) => void;
  moveEvent: (
    eventId: number,
    name: string,
    notes: string | null,
    to: { startDate: ISODate; endDate: ISODate },
    from: { startDate: ISODate; endDate: ISODate }
  ) => void;
  openBedActionModal: (state: BedActionModalState) => void;
  openJoinActionModal: (state: JoinActionModalState) => void;
  openConfirmModal: (state: ConfirmModalState) => void;
  /** Client-side (no full reload) navigation — used for double-click-to-open on empty cells and bookings. */
  navigate: (url: string) => void;
  /** Target room id for "Send to Dorm Storage" — see ensureDormStorageRoomId in grid-data.ts. */
  dormStorageRoomId: number;
  /** Not a click handler — just data along for the ride, so the bed-label menu can default its date picker without threading a separate prop through every render*Block function. */
  today: ISODate;
}

/**
 * Renders one room's rows. Three kinds of 2-row block get grouped together
 * so their rows can coordinate per date column:
 *   - an ACTUAL joined pair (`partnerUnitKey` points at the very next unit)
 *   - a NATIVE two-person bed (Queen/1.5/Double — one unit, 2 slots already)
 *   - two adjacent, still-independent Single beds — a "pairable" pair,
 *     eligible to be linked via right-click but not yet joined
 * Everything else renders as a plain single row per bed, as before.
 */
function renderRoomRows(
  room: RoomGridRow,
  roomIndex: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const roomRowCount = room.units.reduce((sum, unit) => sum + unit.slots.length, 0);
  let roomRowsRendered = 0;
  const rows: React.ReactNode[] = [];
  const units = room.units;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const next = units[i + 1];

    const isJoinedPair = unit.partnerUnitKey != null && next != null && next.key === unit.partnerUnitKey && unit.slots.length === 1 && next.slots.length === 1;
    if (isJoinedPair) {
      const isFirstRoomRow = roomRowsRendered === 0;
      const hasNextUnit = i + 2 < units.length;
      rows.push(...renderPairedBlock(room, roomIndex, unit, next, isFirstRoomRow, hasNextUnit, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      i += 1;
      continue;
    }

    const isNativePair = unit.slots.length === 2;
    if (isNativePair) {
      const isFirstRoomRow = roomRowsRendered === 0;
      const hasNextUnit = i + 1 < units.length;
      rows.push(...renderNativePairBlock(room, roomIndex, unit, isFirstRoomRow, hasNextUnit, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      continue;
    }

    const isSingle = unit.label.toLowerCase() === "single";
    const nextIsPairableSingle = !!next && next.partnerUnitKey == null && next.slots.length === 1 && next.label.toLowerCase() === "single";
    if (isSingle && unit.partnerUnitKey == null && nextIsPairableSingle && next) {
      const isFirstRoomRow = roomRowsRendered === 0;
      const hasNextUnit = i + 2 < units.length;
      rows.push(...renderPairableSinglesBlock(room, roomIndex, unit, next, isFirstRoomRow, hasNextUnit, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      i += 1;
      continue;
    }

    for (let slotIndex = 0; slotIndex < unit.slots.length; slotIndex++) {
      const slot = unit.slots[slotIndex];
      const isFirstRoomRow = roomRowsRendered === 0;
      roomRowsRendered += 1;
      const isFirstUnitRow = slotIndex === 0;
      // Two beds only ever share a dashed (coupled) boundary when the data
      // model says so — a joined pair or a native 2-person bed, both handled
      // above. Every other adjacency inside a room (including between slots
      // of a >2-capacity unit, or between this unit and the next) is never a
      // coupling relationship, so it always gets the plain solid divider,
      // never left blank.
      const isLastSlotOfUnit = slotIndex === unit.slots.length - 1;
      const hasNextRowInRoom = !isLastSlotOfUnit || i + 1 < units.length;

      const specs: CellSpec[] = visibleColumns.map((col) => ({
        col,
        cell: col.dataIndex != null ? slot.cells[col.dataIndex] : null,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: hasNextRowInRoom ? "tr-grid-divider-solid" : "",
      }));

      rows.push(
        <tr key={`${unit.key}-${slotIndex}`} data-bed-id={unit.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
          {isFirstRoomRow && (
            <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
              <div style={{ fontWeight: 600 }}>{room.roomName}</div>
              <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
            </td>
          )}
          {isFirstUnitRow && (
            <td
              className="tr-grid-bed"
              style={{ ...BED_CELL_STYLE, cursor: "pointer" }}
              rowSpan={unit.slots.length}
              {...bedLabelHandlers(unit.bedId, unit.label, room, actions)}
            >
              {unit.label}
            </td>
          )}
          {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
          {renderRowCells(specs, actions)}
          {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
        </tr>
      );
    }
  }

  return rows;
}

/**
 * An ACTUAL joined pair's two rows, decided per date column:
 *   - "solo" dates rowSpan unitA's cell down over unitB's, showing one
 *     merged "Solo Double" spot (unitB omits its own cell there — that's
 *     how HTML expects an irregular rowSpan to be built).
 *   - "double" dates render both cells independently with a dashed divider
 *     on unitA's bottom border.
 *   - dates with no active join at all (this window includes a stretch
 *     before/after the join) render as plain independent cells with a
 *     SOLID divider, and right-click offers starting a fresh join there —
 *     same as two never-joined singles.
 */
function renderPairedBlock(
  room: RoomGridRow,
  roomIndex: number,
  unitA: GridUnit,
  unitB: GridUnit,
  isFirstRoomRow: boolean,
  hasNextUnit: boolean,
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unitA.slots[0];
  const slotB = unitB.slots[0];
  const specsA: CellSpec[] = [];
  const specsB: CellSpec[] = [];
  // Same join/switch/split options already computed per date column below,
  // surfaced again on the bed LABEL's own context menu (see the "Join Beds"
  // item wired where this block's rows are built) — prefers whichever
  // column is actually today, since a label isn't tied to any one date.
  let representativeMenu: { title: string; items: ContextMenuItem[] } | undefined;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const mode = cellA?.joinBadge?.mode;
    const soloActive = mode === "solo" && !!cellB?.joinBadge && cellB.joinBadge.mode === "solo";
    const bothActive = cellA && cellA.state !== "inactive" && cellB && cellB.state !== "inactive";

    if (soloActive && cellA && cellB) {
      const primaryCell = cellA.joinBadge!.isPrimary ? cellA : cellB;
      const primaryBedId = cellA.joinBadge!.isPrimary ? unitA.bedId : unitB.bedId;
      const menu: ContextMenuState["items"] = [
        { label: "Switch to Couple Double", onClick: () => actions.switchJoinMode(unitA.bedId, unitB.bedId, col.date, "double") },
        { label: "Split into Singles", onClick: () => actions.splitJoin(unitA.bedId, unitB.bedId, col.date), danger: true },
      ];
      const soloMenu = { title: `${room.roomName} — Solo Double`, items: menu };
      if (col.date === actions.today || !representativeMenu) representativeMenu = soloMenu;
      const primaryLabel = cellA.joinBadge!.isPrimary ? unitA.label : unitB.label;
      specsA.push({
        col,
        cell: primaryCell,
        bedId: primaryBedId,
        bedLabel: primaryLabel,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        // Consumes both of this pair's own rows via rowSpan, so its bottom
        // edge borders the NEXT unit in the room, not a coupled bed —
        // never dashed here.
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        extraClass: "tr-grid-solo-merged",
        rowSpan: 2,
        menu: soloMenu,
      });
      // unitB renders nothing here — consumed by unitA's rowSpan.
    } else {
      // Join options must survive on an ALREADY-BOOKED cell too (joining is
      // a bed-layout change, independent of whether a guest currently
      // occupies either bed) — bothActive only checks each bed is placed in
      // this room on this date, never booking state.
      const menu: ContextMenuItem[] = mode
        ? [
            { label: mode === "double" ? "Switch to Solo Double" : "Switch to Couple Double", onClick: () => actions.switchJoinMode(unitA.bedId, unitB.bedId, col.date, mode === "double" ? "solo" : "double") },
            { label: "Split into Singles", onClick: () => actions.splitJoin(unitA.bedId, unitB.bedId, col.date), danger: true },
          ]
        : [
            {
              label: "Join as Couple Double",
              onClick: () =>
                actions.openJoinActionModal({
                  bed1Id: unitA.bedId,
                  bed2Id: unitB.bedId,
                  mode: "double",
                  title: `${room.roomName} — Join as Couple Double`,
                  defaultStartDate: col.date,
                  defaultEndDate: cellA?.state === "booked" ? cellA.booking?.departureDate ?? null : null,
                }),
            },
            {
              label: "Join as Solo Double",
              onClick: () =>
                actions.openJoinActionModal({
                  bed1Id: unitA.bedId,
                  bed2Id: unitB.bedId,
                  mode: "solo",
                  title: `${room.roomName} — Join as Solo Double`,
                  defaultStartDate: col.date,
                  defaultEndDate: cellA?.state === "booked" ? cellA.booking?.departureDate ?? null : null,
                }),
            },
          ];
      const pairMenu = bothActive ? { title: `${room.roomName} — Single beds`, items: menu } : undefined;
      if (pairMenu && (col.date === actions.today || !representativeMenu)) representativeMenu = pairMenu;
      specsA.push({
        col,
        cell: cellA,
        bedId: unitA.bedId,
        bedLabel: unitA.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: mode === "double" ? "tr-grid-divider-dashed" : "tr-grid-divider-solid",
        menu: pairMenu,
      });
      specsB.push({
        col,
        cell: cellB,
        bedId: unitB.bedId,
        bedLabel: unitB.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        menu: pairMenu,
      });
    }
  }

  return [
    <tr key={`${unitA.key}-paired`} data-bed-id={unitA.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
          <div style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td
        className="tr-grid-bed"
        style={{ ...BED_CELL_STYLE, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitA.bedId, unitA.label, room, actions, representativeMenu)}
      >
        {unitA.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsA, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unitB.key}-paired`} data-bed-id={unitB.bedId} className={room.excludeFromCapacity ? "tr-grid-room-storage" : undefined} style={roomTrStyle(room, roomIndex)}>
      <td
        className="tr-grid-bed"
        style={{ ...BED_CELL_STYLE, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitB.bedId, unitB.label, room, actions, representativeMenu)}
      >
        {unitB.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsB, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

/**
 * A native two-person bed's (Queen/1.5/Double) own 2 slots, decided per date
 * column: "solo" dates merge into one row (rowSpan), everything else (the
 * default) renders as 2 independent rows with a dashed divider — a Queen
 * always sleeps 2 unless explicitly switched to solo.
 */
function renderNativePairBlock(
  room: RoomGridRow,
  roomIndex: number,
  unit: GridUnit,
  isFirstRoomRow: boolean,
  hasNextUnit: boolean,
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unit.slots[0];
  const slotB = unit.slots[1];
  const specsA: CellSpec[] = [];
  const specsB: CellSpec[] = [];
  // See the same-named variable in renderPairedBlock — surfaced again on the
  // bed label's own context menu.
  let representativeMenu: { title: string; items: ContextMenuItem[] } | undefined;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const active = cellA && cellA.state !== "inactive";
    const soloActive = active && col.dataIndex != null && !!unit.soloByDate?.[col.dataIndex];

    if (soloActive && cellA) {
      const menu: ContextMenuItem[] = [
        { label: `Switch to Couple ${unit.label}`, onClick: () => actions.goCouple(unit.bedId, col.date), danger: true },
      ];
      const soloMenu = { title: `${room.roomName} — Solo ${unit.label}`, items: menu };
      if (col.date === actions.today || !representativeMenu) representativeMenu = soloMenu;
      specsA.push({
        col,
        cell: cellA,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        // Consumes both of this bed's own rows via rowSpan, so its bottom
        // edge borders the NEXT unit in the room — never dashed here.
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        extraClass: "tr-grid-solo-merged",
        rowSpan: 2,
        menu: soloMenu,
      });
    } else {
      const menu: ContextMenuItem[] | undefined = active
        ? [{ label: `Switch to Solo ${unit.label}`, onClick: () => actions.goSolo(unit.bedId, col.date) }]
        : undefined;
      const coupleMenu = menu ? { title: `${room.roomName} — ${unit.label}`, items: menu } : undefined;
      if (coupleMenu && (col.date === actions.today || !representativeMenu)) representativeMenu = coupleMenu;
      specsA.push({
        col,
        cell: cellA,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: active ? "tr-grid-divider-dashed" : hasNextUnit ? "tr-grid-divider-solid" : "",
        menu: coupleMenu,
      });
      specsB.push({
        col,
        cell: cellB,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        menu: coupleMenu,
      });
    }
  }

  return [
    <tr key={`${unit.key}-native-a`} data-bed-id={unit.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
          <div style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td
        className="tr-grid-bed"
        style={{ ...BED_CELL_STYLE, cursor: "pointer" }}
        rowSpan={2}
        {...bedLabelHandlers(unit.bedId, unit.label, room, actions, representativeMenu)}
      >
        {unit.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsA, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unit.key}-native-b`} data-bed-id={unit.bedId} className={room.excludeFromCapacity ? "tr-grid-room-storage" : undefined} style={roomTrStyle(room, roomIndex)}>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsB, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

/**
 * Two adjacent Single beds that are NOT currently joined — always 2
 * independent rows with a solid divider (never merges: nothing to merge
 * until a join actually exists). Right-click on either row offers linking
 * them into a Couple or Solo Double starting that date.
 */
function renderPairableSinglesBlock(
  room: RoomGridRow,
  roomIndex: number,
  unitA: GridUnit,
  unitB: GridUnit,
  isFirstRoomRow: boolean,
  hasNextUnit: boolean,
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unitA.slots[0];
  const slotB = unitB.slots[0];
  const specsA: CellSpec[] = [];
  const specsB: CellSpec[] = [];
  // See the same-named variable in renderPairedBlock — surfaced again on the
  // bed label's own context menu.
  let representativeMenu: { title: string; items: ContextMenuItem[] } | undefined;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const bothActive = cellA && cellA.state !== "inactive" && cellB && cellB.state !== "inactive";
    const menu: ContextMenuItem[] = [
      {
        label: "Join as Couple Double",
        onClick: () =>
          actions.openJoinActionModal({
            bed1Id: unitA.bedId,
            bed2Id: unitB.bedId,
            mode: "double",
            title: `${room.roomName} — Join as Couple Double`,
            defaultStartDate: col.date,
            defaultEndDate: cellA?.state === "booked" ? cellA.booking?.departureDate ?? null : null,
          }),
      },
      {
        label: "Join as Solo Double",
        onClick: () =>
          actions.openJoinActionModal({
            bed1Id: unitA.bedId,
            bed2Id: unitB.bedId,
            mode: "solo",
            title: `${room.roomName} — Join as Solo Double`,
            defaultStartDate: col.date,
            defaultEndDate: cellA?.state === "booked" ? cellA.booking?.departureDate ?? null : null,
          }),
      },
    ];
    const sharedMenu = bothActive ? { title: `${room.roomName} — Single beds`, items: menu } : undefined;
    if (sharedMenu && (col.date === actions.today || !representativeMenu)) representativeMenu = sharedMenu;

    specsA.push({
      col,
      cell: cellA,
      bedId: unitA.bedId,
      bedLabel: unitA.label,
      roomName: room.roomName,
      excludeFromCapacity: room.excludeFromCapacity,
      roomId: room.roomId,
      dividerClass: "tr-grid-divider-solid",
      menu: sharedMenu,
    });
    specsB.push({
      col,
      cell: cellB,
      bedId: unitB.bedId,
      bedLabel: unitB.label,
      roomName: room.roomName,
      excludeFromCapacity: room.excludeFromCapacity,
      roomId: room.roomId,
      dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
      menu: sharedMenu,
    });
  }

  return [
    <tr key={`${unitA.key}-pairable`} data-bed-id={unitA.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
          <div style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td
        className="tr-grid-bed"
        style={{ ...BED_CELL_STYLE, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitA.bedId, unitA.label, room, actions, representativeMenu)}
      >
        {unitA.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsA, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unitB.key}-pairable`} data-bed-id={unitB.bedId} className={room.excludeFromCapacity ? "tr-grid-room-storage" : undefined} style={roomTrStyle(room, roomIndex)}>
      <td
        className="tr-grid-bed"
        style={{ ...BED_CELL_STYLE, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitB.bedId, unitB.label, room, actions, representativeMenu)}
      >
        {unitB.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsB, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

interface CellSpec {
  col: VisibleColumn;
  cell: SlotCell | null;
  bedId: number;
  bedLabel: string;
  roomName: string;
  /** The bed's CURRENT room — captured into the Move Bed / Send to Dorm Storage modal payload so that action is undoable (see BedActionModalState.previousRoomId). */
  roomId: number;
  /** True only inside the system "Dorm Storage" room — see rooms.excludeFromCapacity. */
  excludeFromCapacity: boolean;
  /** Resolved border-bottom class — "" | "tr-grid-divider-solid" | "tr-grid-divider-dashed". Only ever set on the "top" row of a 2-row block. */
  dividerClass: string;
  extraClass?: string;
  /** Bed-specific join/switch/split options for this exact date, if any — merged with the universal Move Bed / Send to Dorm Storage items in cellMenuItems(). Ignored by bookingCellMenuItems (a booking's own menu is strictly Split/Merge/Delete). */
  menu?: { title: string; items: ContextMenuItem[] };
  /** 2 for a "Solo Double"/"Solo Queen" cell spanning both of a pair's rows; otherwise unset (1). */
  rowSpan?: number;
}

/**
 * A free (unbooked) date cell's right-click menu — merges whatever
 * bed-specific join/switch/split options apply on THIS exact date (from
 * spec.menu, if any) with the universal Move Bed / Send to Dorm Storage
 * actions, using the actual clicked cell's date (not just "today") as the
 * effective date. Never called for a cell that has a booking (or a
 * departing booking's tail) on it — see bookingCellMenuItems below, which
 * strictly offers only Split/Merge/Delete there instead.
 */
function cellMenuItems(spec: CellSpec, actions: GridActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [...(spec.menu?.items ?? [])];
  items.push({
    label: "Move Bed",
    onClick: () => actions.openBedActionModal({ mode: "move", bedId: spec.bedId, bedLabel: spec.bedLabel, defaultDate: spec.col.date, previousRoomId: spec.roomId }),
  });
  if (!spec.excludeFromCapacity) {
    items.push({
      label: "Send to Dorm Storage",
      danger: true,
      onClick: () => actions.openBedActionModal({ mode: "storage", bedId: spec.bedId, bedLabel: spec.bedLabel, defaultDate: spec.col.date, previousRoomId: spec.roomId }),
    });
  }
  return items;
}

/**
 * Right-click menu for a cell that HAS a booking on it — either a booking's
 * own pill, or a plain "turnover" cell showing only a departing booking's
 * half-cell tail (see renderSingleCell). Strictly Split Booking / Merge
 * Bookings / Delete Booking, never the bed-layout actions cellMenuItems
 * offers — those are a structural change to the BED, and mixing them into
 * a booking's own menu invited moving/re-typing a bed out from under an
 * in-progress stay. Move Bed / Send to Dorm Storage / join options are
 * still reachable from the bed's own label column regardless.
 */
function bookingCellMenuItems(
  spec: CellSpec,
  actions: GridActions,
  booking: { id: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate },
  /** The exact date column that was right-clicked, if different from spec.col.date (a booking pill spans several columns — see renderBookingPill's onContextMenu). */
  clickDate?: ISODate
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const splitDate = clickDate ?? spec.col.date;
  // Only offer a split strictly between the two edges — splitting exactly
  // on the arrival or departure date would leave a zero-night booking on
  // one side.
  if (splitDate > booking.arrivalDate && splitDate < booking.departureDate) {
    items.push({
      label: `Split Booking on ${formatDateUk(splitDate)}`,
      onClick: () =>
        actions.openConfirmModal({
          title: "Split Booking",
          message: `Split ${booking.guestName}'s booking into two separate bookings, dividing on ${formatDateUk(splitDate)}?`,
          confirmLabel: "Split",
          onConfirm: () => actions.splitBooking(booking.id, splitDate, booking.guestName, booking.departureDate),
        }),
    });
  }
  // `spec` is always the run's own first (arrival) cell, or (for a
  // turnover-only free cell) the departing booking passed as `booking`
  // itself — the only places SlotCell.departingBooking can be set (see
  // packBookingsIntoSlots in grid.ts). A matching guest name on a
  // back-to-back adjacent booking in the same bed is exactly the "checked
  // out and back in same day" case Merge Bookings reverses — but only
  // right-clicking the EXACT turnover day itself (this booking's own
  // arrival date, which is also the departing booking's departure date):
  // a multi-night pill's other days share this same `spec`/departingBooking
  // data (it's per-run, not per-column) and would otherwise offer Merge on
  // every night, not just the one day the two stays actually meet.
  const departingBooking = spec.cell?.departingBooking;
  if (
    departingBooking &&
    departingBooking.id !== booking.id &&
    splitDate === booking.arrivalDate &&
    departingBooking.guestName.trim().toLowerCase() === booking.guestName.trim().toLowerCase()
  ) {
    items.push({
      label: "Merge Bookings",
      onClick: () =>
        actions.openConfirmModal({
          title: "Merge Bookings",
          message: `Merge ${booking.guestName}'s two bookings (${formatDateUk(departingBooking.arrivalDate)}–${formatDateUk(departingBooking.departureDate)} and ${formatDateUk(booking.arrivalDate)}–${formatDateUk(booking.departureDate)}) into one continuous stay?`,
          confirmLabel: "Merge",
          onConfirm: () => actions.mergeBookings(departingBooking.id, booking.id, booking.guestName),
        }),
    });
  }
  items.push({
    label: "Delete Booking",
    danger: true,
    onClick: () =>
      actions.openConfirmModal({
        title: "Delete Booking",
        message: `Delete ${booking.guestName}'s booking (${formatDateUk(booking.arrivalDate)}–${formatDateUk(booking.departureDate)})? This can be undone with Ctrl+Z immediately after.`,
        confirmLabel: "Delete",
        onConfirm: () => actions.cancelBooking(booking.id, booking.guestName),
      }),
  });
  return items;
}

/**
 * Renders one row's (or, for a solo-merged pair, one shared) sequence of
 * date cells. A booking that spans several consecutive visible dates
 * collapses into a single colSpan'd pill rather than repeating the guest
 * name in every night's cell — mirrors how the event lane above merges
 * bands, just keyed off `cell.booking.id`. A run only merges while every
 * column shares the same divider treatment and rowSpan, so a mid-stay
 * change (e.g. a joined pair splitting) still breaks the pill at the right
 * date instead of painting through it. Crossing a weekend boundary does NOT
 * break the run — the pill stays one continuous element with the guest name
 * shown exactly once, and still gets accurate per-date weekend shading via
 * the tiled background gradient in renderBookingPill (see weekendOverlayVars).
 */
function renderRowCells(specs: CellSpec[], actions: GridActions): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < specs.length) {
    const spec = specs[i];
    if (spec.cell && spec.cell.state === "booked" && spec.cell.booking) {
      const bookingId = spec.cell.booking.id;
      let j = i + 1;
      while (
        j < specs.length &&
        specs[j].cell?.state === "booked" &&
        specs[j].cell?.booking?.id === bookingId &&
        specs[j].dividerClass === spec.dividerClass &&
        !!specs[j].menu === !!spec.menu &&
        (specs[j].rowSpan ?? 1) === (spec.rowSpan ?? 1)
      ) {
        j += 1;
      }
      out.push(renderBookingPill(specs.slice(i, j), actions));
      i = j;
    } else {
      out.push(renderSingleCell(spec, actions));
      i += 1;
    }
  }
  return out;
}

/** One free/inactive/loading date cell — never part of a booking, so it always renders alone. */
/**
 * Half-width "tail" for a booking whose departureDate is exactly this cell's
 * date (see SlotCell.departingBooking) — checkout is exclusive, so this
 * date never belongs to that booking's own occupied-night run, but the
 * guest is still physically checking out THIS morning. Rendered flush
 * against the left edge so it sits back-to-back with whatever occupies the
 * right half (a same-day arrival's pill, inset to start at 50%, or the
 * ordinary "+" new-booking affordance narrowed to the right half).
 */
function renderDepartingTail(booking: GridBooking, actions: GridActions) {
  const editHref = `/bookings/${booking.id}`;
  return (
    <a
      key="departing-tail"
      href={editHref}
      draggable={false}
      // Shares .tr-grid-booking-pill's own background/border/text styling
      // (uniform colour throughout a booking's whole span, no separate
      // muted/grey identity for the tail) — .tr-grid-departing-tail only
      // overrides position/radius specifics.
      className="tr-grid-booking-pill tr-grid-departing-tail"
      // Bleeds -3px into the PREVIOUS cell's padding (the same trick
      // .tr-pill-continues-start/-end use) so this tail visually fuses with
      // that booking's own last-night pill — which now always renders
      // flush/bled on ITS right edge too (see renderBookingPill) — instead
      // of the two sitting in separate <td>s with a bare gap between them,
      // which read as a detached, floating box.
      style={{ left: -3, width: COLUMN_WIDTH / 2 + 3 }}
      title={`${booking.guestName} - checks out today`}
      // See the identical comment on the "+" new-booking link in
      // renderSingleCell — without this, the viewport's own drag-to-pan
      // handler steals pointer capture and the click/dblclick below never
      // fires on this element at all.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        e.preventDefault();
        actions.navigate(editHref);
      }}
    >
      {/* No name here — it's already shown once in the booking's own pill; this is just that same pill's visual tail. */}
    </a>
  );
}

function renderSingleCell(spec: CellSpec, actions: GridActions) {
  const { col, cell, bedId, roomName, dividerClass, extraClass, excludeFromCapacity, rowSpan } = spec;
  const classes = ["tr-grid-cell"];
  if (dividerClass) classes.push(dividerClass);
  if (extraClass) classes.push(extraClass);
  const weekendStyle = weekendOverlayVars(col.date);

  // A "free" cell can still carry a departing booking's half-cell tail (see
  // SlotCell.departingBooking) — right-clicking it is right-clicking that
  // booking, so it gets the strict Split/Merge/Delete menu, not the
  // bed-layout one a genuinely empty cell offers.
  const onContextMenu = (e: React.MouseEvent) =>
    cell?.departingBooking
      ? actions.openMenu(e, cell.departingBooking.guestName, bookingCellMenuItems(spec, actions, cell.departingBooking, col.date))
      : actions.openMenu(e, spec.menu?.title ?? `${roomName} — ${spec.bedLabel}`, cellMenuItems(spec, actions));

  if (!cell || cell.state === "inactive") {
    return (
      <td
        key={col.globalIndex}
        rowSpan={rowSpan}
        className={[...classes, "tr-grid-inactive"].join(" ")}
        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, ...weekendStyle }}
        title={cell ? "Not placed in this room on this date" : "Loading…"}
      />
    );
  }

  // A bed parked in Dorm Storage is off active duty — no new bookings can
  // start on it, so the cell renders as a plain inert box: no "+" affordance,
  // no hover state, no click/double-click navigation. Right-click still
  // works (Move Bed, to bring it back into service).
  if (excludeFromCapacity) {
    return (
      <td
        key={col.globalIndex}
        rowSpan={rowSpan}
        className={classes.join(" ")}
        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, ...weekendStyle, cursor: "default" }}
        onContextMenu={onContextMenu}
        title={`${roomName} — in Dorm Storage, not bookable`}
      />
    );
  }

  const newBookingHref = `/bookings/new?bedId=${bedId}&arrival=${col.date}&departure=${addDaysIso(col.date, 1)}`;
  const departingBooking = cell.departingBooking;

  return (
    <td
      key={col.globalIndex}
      rowSpan={rowSpan}
      className={classes.join(" ")}
      style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, ...weekendStyle }}
      onContextMenu={onContextMenu}
      title={`New booking - ${roomName}, night of ${formatDateUk(col.date)}`}
    >
      {departingBooking && renderDepartingTail(departingBooking, actions)}
      <a
        className="tr-grid-new"
        draggable={false}
        href={newBookingHref}
        // CRITICAL: without this, the pointerdown bubbles to the grid
        // viewport's own onPointerDown (drag-to-pan), which calls its OWN
        // setPointerCapture on the SAME pointerId — capture is
        // last-caller-wins, so the viewport silently steals every
        // subsequent mouse/click/dblclick event, re-targeting them at the
        // viewport <div> instead of this <a> (same fix onPillPointerDown
        // already needed, and for the same reason — see its own comment).
        // Without this, double-clicking a free cell to start a new booking
        // silently does nothing at all.
        onPointerDown={(e) => e.stopPropagation()}
        // Single click is reserved for the grid's pan/click disambiguation
        // and (once dragging lands) selection — only a double-click starts a
        // new booking. The href is kept (rather than dropped) so opening in
        // a new tab / copying the link still works via the browser's own
        // context menu or a modifier-click. Navigation itself goes through
        // Next's client-side router (actions.navigate) rather than a full
        // page reload.
        onClick={(e) => e.preventDefault()}
        onDoubleClick={(e) => {
          e.preventDefault();
          actions.navigate(newBookingHref);
        }}
        // A departing guest's tail already claims the left half of this
        // column (same-day checkout) — narrow the "start a new booking"
        // affordance to the remaining right half so the two don't overlap.
        style={departingBooking ? { position: "absolute", left: COLUMN_WIDTH / 2, right: 0, top: 0, bottom: 0 } : undefined}
      >
        +
      </a>
    </td>
  );
}

// --- Booking pill drag: center-grab (move bed) vs edge-grab (resize dates) -
//
// Only one pill can be dragged at a time, and none of this needs a React
// re-render while it's happening (it's pure cursor/outline feedback plus a
// single committed change on release) — a module-level variable is simpler
// than threading a ref through renderBookingPill, which isn't a component
// and can't call useRef itself. Pointer capture (set on pointerdown) keeps
// delivering move/up events to the SAME element even once the cursor leaves
// the pill, so no window-level listeners are needed either.
type PillDragKind = "move" | "resize-start" | "resize-end";

type DropValidity = "valid" | "swap" | "invalid";

interface PillDragState {
  kind: PillDragKind;
  bookingId: number;
  guestName: string;
  bedId: number;
  arrivalDate: ISODate;
  departureDate: ISODate;
  startX: number;
  startY: number;
  moved: boolean;
  hoverBedId: number | null;
  hoverRowEl: HTMLElement | null;
  pillEl: HTMLElement;
  /** The pill's own <td> rect at drag start — resize/move geometry is computed relative to this, never to the live (unchanged) DOM. */
  originRect: DOMRect | null;
  /** The floating preview (resize's dashed outline, or move's exact-size ghost) — created lazily on first move so a plain click never touches the DOM. */
  ghostEl: HTMLElement | null;
  /** Whole-day offset (both kinds): resize clamps this to a valid date range; move applies it unclamped to BOTH dates equally (a same-length shift, not a resize). What onPillPointerUp commits, so the commit always matches exactly what the ghost last showed. */
  lastDeltaDays: number;
  /** Move only: whether the currently-hovered bed+date target is a legal drop (free), a swap candidate (exactly one conflicting booking that can cleanly move back), or blocked — null while no target bed is resolved yet. */
  dropValidity: DropValidity | null;
  /** Move only: the booking(s) currently occupying the hovered target bed for the dragged booking's (possibly date-shifted) range. */
  conflicts: OccupancyEntry[];
}

let pillDragState: PillDragState | null = null;

/**
 * Safety-net cleanup, callable with no event object in hand — used both by
 * the pill's own onPointerUp/onPointerCancel AND a window-level listener
 * (see useDragSafetyNet below) for the case pointer capture is somehow lost
 * without either of those firing on the pill itself (e.g. the OS steals
 * focus mid-drag). Without this, a failed/interrupted move leaves the
 * dimmed pill opacity and/or a ghost stuck until a full page refresh.
 */
function clearPillDragVisuals() {
  const ds = pillDragState;
  if (!ds) return;
  ds.pillEl.style.opacity = "";
  ds.pillEl.style.cursor = "";
  ds.ghostEl?.remove();
  pillDragState = null;
}

/** Left/right 15% of the pill = resize that edge's date; the middle 70% = move (change bed). */
function pillDragKindAtOffset(offsetX: number, width: number): PillDragKind {
  if (width <= 0) return "move";
  const ratio = offsetX / width;
  if (ratio < 0.15) return "resize-start";
  if (ratio > 0.85) return "resize-end";
  return "move";
}

/**
 * Clamps a raw (unsnapped-to-validity) day offset so the resulting date
 * range never collapses to zero/negative nights — the one thing that must
 * hold true throughout the drag, not just at commit, since the ghost is
 * only ever allowed to show a legal target.
 */
function clampResizeDeltaDays(ds: PillDragState, rawDeltaDays: number): number {
  const nights = nightsBetween(ds.arrivalDate, ds.departureDate);
  if (ds.kind === "resize-start") return Math.min(rawDeltaDays, nights - 1);
  if (ds.kind === "resize-end") return Math.max(rawDeltaDays, -(nights - 1));
  return rawDeltaDays;
}

function resizeGhostLabel(ds: PillDragState, deltaDays: number): string {
  if (ds.dropValidity === "invalid") return `Occupied by ${ds.conflicts[0]?.guestName ?? "another booking"} — can't extend`;
  return ds.kind === "resize-start"
    ? `Check-in ${formatDateUk(addDaysIso(ds.arrivalDate, deltaDays))}`
    : `Check-out ${formatDateUk(addDaysIso(ds.departureDate, deltaDays))}`;
}

function createResizeGhost(originRect: DOMRect): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "tr-pill-resize-ghost";
  // The real pill sits inset top:3px/bottom:3px within its row (see
  // .tr-grid-booking-pill), not filling the row's full height — match that
  // exactly rather than the row's own (taller) rect, or the ghost reads as
  // a visibly thicker/blockier box than the pill it's supposed to preview.
  ghost.style.top = `${originRect.top + 3}px`;
  ghost.style.height = `${originRect.height - 6}px`;
  const label = document.createElement("span");
  label.className = "tr-pill-resize-ghost-label";
  ghost.appendChild(label);
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Repositions the ghost from the ORIGINAL (drag-start) rect plus a whole
 * number of day-widths — never from the live pointer position directly —
 * so it can only ever land exactly on a column boundary, not partway
 * through one. This is the "snap to day boundaries" behaviour: the pixel
 * delta is converted to a day count once (Math.round in onPillPointerMove)
 * and every subsequent computation is in whole days from there.
 */
function updateResizeGhost(ds: PillDragState, deltaDays: number) {
  if (!ds.ghostEl || !ds.originRect) return;
  const offsetPx = deltaDays * COLUMN_WIDTH;
  // Width must match exactly (new nights) * COLUMN_WIDTH — the ghost's
  // whole job is to preview how long the booking will be. left is offset
  // by half a column from the <td>'s own edge to match where the real
  // pill's arrival half-cell inset actually starts (see leftInset in
  // renderBookingPill) — the committed pill+departure-tail pair's combined
  // visual span is exactly (nights * COLUMN_WIDTH) wide but shifted right
  // by half a column from the td boundaries, not flush with them. A
  // previous version instead shaved an extra COLUMN_WIDTH off the WIDTH to
  // approximate this, which underrepresented the booking's real length
  // (collapsing a 1-night resize's ghost toward zero) — half is only ever
  // applied to the position here, never subtracted from the length.
  const half = COLUMN_WIDTH / 2;
  if (ds.kind === "resize-start") {
    ds.ghostEl.style.left = `${ds.originRect.left + offsetPx + half}px`;
    ds.ghostEl.style.width = `${ds.originRect.width - offsetPx}px`;
  } else {
    ds.ghostEl.style.left = `${ds.originRect.left + half}px`;
    ds.ghostEl.style.width = `${ds.originRect.width + offsetPx}px`;
  }
  ds.ghostEl.classList.toggle("tr-pill-resize-ghost-invalid", ds.dropValidity === "invalid");
  const label = ds.ghostEl.querySelector<HTMLElement>(".tr-pill-resize-ghost-label");
  if (label) label.textContent = resizeGhostLabel(ds, deltaDays);
}

/**
 * Center-grab (full 2D move) preview: a fixed-position box matching the
 * dragged pill's exact width/height/shape (never the whole row) — created
 * once at drag-start size, then repositioned on BOTH axes as the pointer
 * moves: vertically to track whichever row it's over, horizontally by the
 * same snapped whole-day offset the resize ghost uses (see
 * clampResizeDeltaDays's sibling logic inline in onPillPointerMove — a
 * move never collapses/expands the stay, so there's nothing to clamp).
 * Colour reflects the live collision check rather than a blanket highlight.
 */
function createMoveGhost(ds: PillDragState): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "tr-pill-move-ghost";
  // Width must match the booking's real length exactly — ds.originRect.width
  // already IS (nights) * COLUMN_WIDTH. See the comment in updateResizeGhost
  // for why this used to subtract an extra COLUMN_WIDTH (a "half-cell
  // preview" idea that instead made every ghost, and a 1-night booking's
  // ghost especially, shorter than the booking actually is). Height/top are
  // set per-frame in updateMoveGhost instead of fixed here, since they
  // track whichever row is currently hovered (rows can differ in height —
  // a Solo Double's merged row is double-height).
  ghost.style.width = `${ds.originRect!.width}px`;
  const label = document.createElement("span");
  label.className = "tr-pill-move-ghost-label";
  label.textContent = ds.guestName;
  ghost.appendChild(label);
  document.body.appendChild(ghost);
  return ghost;
}

function moveGhostLabel(ds: PillDragState): string {
  if (ds.dropValidity === "swap") return `Swap with ${ds.conflicts[0]?.guestName ?? "guest"}`;
  if (ds.dropValidity === "invalid") return "Occupied — can't drop here";
  const deltaDays = ds.lastDeltaDays;
  if (deltaDays === 0) return ds.guestName;
  return `${ds.guestName} — ${formatDateUk(addDaysIso(ds.arrivalDate, deltaDays))} to ${formatDateUk(addDaysIso(ds.departureDate, deltaDays))}`;
}

function updateMoveGhost(ds: PillDragState, rowRect: DOMRect) {
  if (!ds.ghostEl || !ds.originRect) return;
  // Match the real pill's own top:3px/bottom:3px inset (see
  // .tr-grid-booking-pill) within WHICHEVER row is currently hovered —
  // computed fresh each frame (not fixed at drag-start) so hovering a
  // taller row (a Solo Double's merged row) previews the pill at that
  // row's real height, not the origin row's.
  ds.ghostEl.style.top = `${rowRect.top + 3}px`;
  ds.ghostEl.style.height = `${rowRect.height - 6}px`;
  // Left is offset by half a column past the <td>'s own edge — see the
  // matching comment in updateResizeGhost for why (the arrival half-cell
  // inset the committed pill actually has).
  ds.ghostEl.style.left = `${ds.originRect.left + ds.lastDeltaDays * COLUMN_WIDTH + COLUMN_WIDTH / 2}px`;
  ds.ghostEl.classList.remove("tr-pill-move-ghost-valid", "tr-pill-move-ghost-swap", "tr-pill-move-ghost-invalid");
  if (ds.dropValidity) ds.ghostEl.classList.add(`tr-pill-move-ghost-${ds.dropValidity}`);
  const label = ds.ghostEl.querySelector<HTMLElement>(".tr-pill-move-ghost-label");
  if (label) label.textContent = moveGhostLabel(ds);
}

function onPillPointerDown(
  e: React.PointerEvent<HTMLAnchorElement>,
  booking: { id: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate },
  bedId: number
) {
  if (e.button !== 0) return;
  // CRITICAL: without this, the event keeps bubbling to the grid viewport's
  // own onPointerDown (drag-to-pan) handler, which calls its OWN
  // setPointerCapture on the SAME pointerId — capture is last-caller-wins,
  // so the viewport silently steals every pill drag and pans the grid
  // instead of moving/resizing the booking.
  e.stopPropagation();
  const rect = e.currentTarget.getBoundingClientRect();
  const kind = pillDragKindAtOffset(e.clientX - rect.left, rect.width);
  e.currentTarget.setPointerCapture(e.pointerId);
  const td = e.currentTarget.closest("td");
  pillDragState = {
    kind,
    bookingId: booking.id,
    guestName: booking.guestName,
    bedId,
    arrivalDate: booking.arrivalDate,
    departureDate: booking.departureDate,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    hoverBedId: null,
    hoverRowEl: null,
    pillEl: e.currentTarget,
    // The <td> (not the <a>) rect — its width is an exact multiple of
    // COLUMN_WIDTH (colSpan * COLUMN_WIDTH), so day-offset math against it
    // lines up perfectly with column boundaries; the <a>'s own box has
    // padding/border insets that would throw that off by a few px.
    originRect: (td ?? e.currentTarget).getBoundingClientRect(),
    ghostEl: null,
    lastDeltaDays: 0,
    dropValidity: null,
    conflicts: [],
  };
}

function onPillPointerMove(e: React.PointerEvent<HTMLAnchorElement>) {
  const ds = pillDragState;
  if (!ds) {
    // Not dragging yet — just show which zone a click would grab.
    const rect = e.currentTarget.getBoundingClientRect();
    const kind = pillDragKindAtOffset(e.clientX - rect.left, rect.width);
    e.currentTarget.style.cursor = kind === "move" ? "grab" : "ew-resize";
    return;
  }

  const dx = e.clientX - ds.startX;
  const dy = e.clientY - ds.startY;
  if (!ds.moved && Math.hypot(dx, dy) > 4) ds.moved = true;
  if (!ds.moved) return;

  // A real drag is underway — stop it from also being read as a native link
  // drag/URL-preview gesture or a text selection.
  e.preventDefault();
  e.stopPropagation();
  ds.pillEl.style.opacity = "0.6";

  if (ds.kind === "move") {
    // Center-grab: full 2D — horizontal movement shifts BOTH dates by the
    // same snapped day count (the stay's length never changes, so there's
    // nothing to clamp the way resize does), vertical movement (which row
    // the pointer is over) picks the target bed. The live pill is never
    // reparented/restyled mid-drag — an exact-size ghost (createMoveGhost)
    // tracks the proposed position instead, coloured by a live collision
    // check rather than a blanket row outline.
    if (!ds.ghostEl) ds.ghostEl = createMoveGhost(ds);
    ds.lastDeltaDays = Math.round(dx / COLUMN_WIDTH);
    const proposedArrival = addDaysIso(ds.arrivalDate, ds.lastDeltaDays);
    const proposedDeparture = addDaysIso(ds.departureDate, ds.lastDeltaDays);

    const target = document.elementFromPoint(e.clientX, e.clientY);
    const rowEl = target instanceof Element ? (target.closest("tr[data-bed-id]") as HTMLElement | null) : null;
    // No row under the pointer (e.g. hovering the sticky room/bed label
    // columns) falls back to the booking's own bed, so a pure date-only
    // drag still resolves to a valid same-bed move.
    const targetBedId = rowEl?.dataset.bedId ? Number(rowEl.dataset.bedId) : ds.bedId;
    ds.hoverRowEl = rowEl;
    ds.hoverBedId = targetBedId;

    const targetConflicts = conflictingBookings(targetBedId, proposedArrival, proposedDeparture, ds.bookingId);
    // A capacity-2 bed (native Queen/1.5/Double) has room for one more
    // occupant even with an existing booking already in its other slot —
    // only a FULLY occupied bed (conflicts >= capacity) needs a swap or is
    // blocked outright. Checking conflict count alone (ignoring capacity)
    // used to treat "the bed's other slot is taken" as "the bed is full"
    // even on a 2-person bed with room to spare.
    const targetCapacity = bedCapacityIndex.get(targetBedId) ?? 1;
    if (targetConflicts.length < targetCapacity) {
      ds.dropValidity = "valid";
      ds.conflicts = [];
    } else if (targetBedId !== ds.bedId && targetConflicts.length === 1 && targetCapacity === 1) {
      // Swap candidate — but only amber if evicting the one booking already
      // there back into the ORIGIN bed, keeping ITS OWN unchanged dates,
      // doesn't itself collide with anything ELSE already sitting in the
      // origin bed. Skipping this reciprocity check is exactly what used to
      // let a "successful" swap silently bounce the other booking into a
      // THIRD booking's dates — which grid.ts would then paper over by
      // spawning a phantom overflow row rather than actually resolving it.
      const other = targetConflicts[0];
      const reciprocalConflicts = conflictingBookings(ds.bedId, other.arrivalDate, other.departureDate, ds.bookingId);
      ds.dropValidity = reciprocalConflicts.length === 0 ? "swap" : "invalid";
      ds.conflicts = targetConflicts;
    } else {
      // Same-bed date move landing on an occupied date, or the target bed
      // is already at capacity with more than one booking in the way —
      // neither is resolvable by a simple swap.
      ds.dropValidity = "invalid";
      ds.conflicts = targetConflicts;
    }

    ds.pillEl.style.cursor = ds.dropValidity === "invalid" ? "not-allowed" : "grabbing";
    const ghostRowEl = rowEl ?? e.currentTarget.closest("tr");
    if (ghostRowEl) updateMoveGhost(ds, ghostRowEl.getBoundingClientRect());
    return;
  }

  // Edge-grab: locked to this row/bed, only horizontal movement (which date
  // column the pointer is over) matters. The live booking is never mutated
  // mid-drag — Math.round snaps the raw pixel delta to a whole column index
  // once, then a dashed ghost overlay (not the real pill) is redrawn from
  // that snapped day count. The actual date change only ever happens once,
  // in onPillPointerUp, from the last value computed here.
  if (!ds.ghostEl) ds.ghostEl = createResizeGhost(ds.originRect!);
  const rawDeltaDays = Math.round(dx / COLUMN_WIDTH);
  ds.lastDeltaDays = clampResizeDeltaDays(ds, rawDeltaDays);
  // Extending an edge can reach into a date this bed is already occupied
  // on (by a DIFFERENT booking) — unlike a move, there's no swap option
  // here (only one booking's dates are changing), so this is always just
  // valid/invalid, never a swap candidate. Blocking it here (ghost turns
  // red, commit refuses in onPillPointerUp) is what stops a resize from
  // ever silently pushing a bed over capacity — see checkBedCapacity on
  // the server for the same guard's authoritative backstop.
  const proposedArrival = ds.kind === "resize-start" ? addDaysIso(ds.arrivalDate, ds.lastDeltaDays) : ds.arrivalDate;
  const proposedDeparture = ds.kind === "resize-end" ? addDaysIso(ds.departureDate, ds.lastDeltaDays) : ds.departureDate;
  ds.conflicts = conflictingBookings(ds.bedId, proposedArrival, proposedDeparture, ds.bookingId);
  ds.dropValidity = ds.conflicts.length === 0 ? "valid" : "invalid";
  updateResizeGhost(ds, ds.lastDeltaDays);
}

function onPillPointerUp(e: React.PointerEvent<HTMLAnchorElement>, actions: GridActions) {
  const ds = pillDragState;
  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  const deltaDays = ds?.lastDeltaDays ?? 0;
  clearPillDragVisuals();
  if (!ds || !ds.moved) return; // No real drag — a plain click/dblclick, handled by onClick/onDoubleClick.

  e.preventDefault();
  e.stopPropagation();

  if (ds.kind === "move") {
    if (ds.hoverBedId == null || (ds.dropValidity !== "valid" && ds.dropValidity !== "swap")) return;
    const toArrival = addDaysIso(ds.arrivalDate, deltaDays);
    const toDeparture = addDaysIso(ds.departureDate, deltaDays);
    if (ds.hoverBedId === ds.bedId && deltaDays === 0) return; // dropped back where it started — no-op

    if (ds.dropValidity === "valid") {
      actions.moveBooking(
        ds.bookingId,
        { bedId: ds.hoverBedId, arrivalDate: toArrival, departureDate: toDeparture },
        { bedId: ds.bedId, arrivalDate: ds.arrivalDate, departureDate: ds.departureDate },
        ds.guestName
      );
    } else {
      const other = ds.conflicts[0];
      actions.swapBookings({
        draggedBookingId: ds.bookingId,
        otherBookingId: other.id,
        fromBedId: ds.bedId,
        toBedId: ds.hoverBedId,
        draggedFrom: { arrivalDate: ds.arrivalDate, departureDate: ds.departureDate },
        draggedTo: { arrivalDate: toArrival, departureDate: toDeparture },
        draggedName: ds.guestName,
        otherName: other.guestName,
      });
    }
    return;
  }

  if (deltaDays === 0) return;
  // Extending into a date this bed is already occupied on — no action,
  // matching every other drag-based collision in this file (the move/swap
  // branch above, the join drop-target check). The server's
  // checkBedCapacity guard would reject this anyway; refusing it here
  // means the drag itself never commits an invalid change in the first
  // place.
  if (ds.dropValidity === "invalid") return;
  if (ds.kind === "resize-start") {
    actions.resizeBookingDates(ds.bookingId, "arrivalDate", ds.arrivalDate, addDaysIso(ds.arrivalDate, deltaDays), ds.guestName);
  } else {
    actions.resizeBookingDates(ds.bookingId, "departureDate", ds.departureDate, addDaysIso(ds.departureDate, deltaDays), ds.guestName);
  }
}

/**
 * Horizontal-only drag state for an event band: unlike a booking pill,
 * there's no bed/row dimension to change — dragging left/right just shifts
 * BOTH startDate and endDate by the same whole-day offset, the same way a
 * booking pill's center-grab move shifts a stay without changing its
 * length. Module-level for the same reason as pillDragState: the pointer
 * handlers are plain functions (not component closures), so drag state
 * can't live in React state without a re-render on every pixel of motion.
 */
interface EventDragState {
  eventId: number;
  name: string;
  notes: string | null;
  startDate: ISODate;
  endDate: ISODate;
  startX: number;
  moved: boolean;
  bandEl: HTMLElement;
  originRect: DOMRect | null;
  ghostEl: HTMLElement | null;
  lastDeltaDays: number;
}

let eventDragState: EventDragState | null = null;
// pointerup clears eventDragState before the browser's own follow-up
// "click" event fires on the same element, so that click can't check
// eventDragState.moved directly (it's already null) — this flag survives
// the gap so the click handler can still tell "was this the tail end of a
// real drag" and suppress the link navigation, same trick used for the
// grid viewport's own drag-to-pan vs click distinction (suppressClickRef).
let suppressNextEventClick = false;

function clearEventDragVisuals() {
  const ds = eventDragState;
  if (!ds) return;
  ds.bandEl.style.opacity = "";
  ds.bandEl.style.cursor = "";
  ds.ghostEl?.remove();
  eventDragState = null;
}

function onEventPointerDown(
  e: React.PointerEvent<HTMLAnchorElement>,
  event: { id: number; name: string; notes: string | null; startDate: ISODate; endDate: ISODate }
) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.currentTarget.setPointerCapture(e.pointerId);
  const td = e.currentTarget.closest("td");
  eventDragState = {
    eventId: event.id,
    name: event.name,
    notes: event.notes,
    startDate: event.startDate,
    endDate: event.endDate,
    startX: e.clientX,
    moved: false,
    bandEl: e.currentTarget,
    originRect: (td ?? e.currentTarget).getBoundingClientRect(),
    ghostEl: null,
    lastDeltaDays: 0,
  };
}

function onEventPointerMove(e: React.PointerEvent<HTMLAnchorElement>) {
  const ds = eventDragState;
  if (!ds) return;
  const dx = e.clientX - ds.startX;
  if (!ds.moved && Math.abs(dx) > 4) ds.moved = true;
  if (!ds.moved) return;

  e.preventDefault();
  e.stopPropagation();
  ds.bandEl.style.opacity = "0.6";
  ds.bandEl.style.cursor = "grabbing";

  if (!ds.ghostEl) ds.ghostEl = createResizeGhost(ds.originRect!);
  ds.lastDeltaDays = Math.round(dx / COLUMN_WIDTH);
  const offsetPx = ds.lastDeltaDays * COLUMN_WIDTH;
  ds.ghostEl.style.left = `${ds.originRect!.left + offsetPx}px`;
  ds.ghostEl.style.width = `${ds.originRect!.width}px`;
  const label = ds.ghostEl.querySelector<HTMLElement>(".tr-pill-resize-ghost-label");
  if (label) {
    label.textContent =
      ds.lastDeltaDays === 0
        ? ds.name
        : `${ds.name} — ${formatDateUk(addDaysIso(ds.startDate, ds.lastDeltaDays))} to ${formatDateUk(addDaysIso(ds.endDate, ds.lastDeltaDays))}`;
  }
}

function onEventPointerUp(e: React.PointerEvent<HTMLAnchorElement>, actions: GridActions) {
  const ds = eventDragState;
  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  const deltaDays = ds?.lastDeltaDays ?? 0;
  suppressNextEventClick = ds?.moved ?? false;
  clearEventDragVisuals();
  if (!ds || !ds.moved || deltaDays === 0) return;

  e.preventDefault();
  e.stopPropagation();

  actions.moveEvent(
    ds.eventId,
    ds.name,
    ds.notes,
    { startDate: addDaysIso(ds.startDate, deltaDays), endDate: addDaysIso(ds.endDate, deltaDays) },
    { startDate: ds.startDate, endDate: ds.endDate }
  );
}

/**
 * A booking rendered once as a continuous rounded pill spanning every
 * consecutive visible date it covers, instead of repeating the guest name
 * (and arrival/departure marks as raw "<"/"/" characters) in every night's
 * cell. Rounded caps only appear on the true check-in/check-out edge — a
 * run cut off by the edge of the loaded/virtualized window gets a flat edge
 * and a small chevron instead, so it stays visually clear the stay
 * continues off-screen rather than actually ending there.
 */
function renderBookingPill(run: CellSpec[], actions: GridActions) {
  const first = run[0];
  const last = run[run.length - 1];
  const cell = first.cell!;
  const booking = cell.booking!;
  const lastCell = last.cell!;
  const startsHere = cell.isArrival === true;
  const endsHere = lastCell.isDeparture === true;

  const classes = ["tr-grid-cell", "tr-grid-booking-cell"];
  if (first.dividerClass) classes.push(first.dividerClass);
  if (first.extraClass) classes.push(first.extraClass);

  const pillClasses = ["tr-grid-booking-pill"];
  if (!startsHere) pillClasses.push("tr-pill-continues-start");
  // The right edge of a booking's OWN run is never the true "ending cell"
  // any more (see leftInset/departingBooking below) — the departure date
  // itself is a separate <td> the run structurally can't include (its
  // state belongs to whatever's free/arriving there instead), so this edge
  // always bleeds flush into that next cell, same as a window-cutoff —
  // the half-cell rounded end cap lives on the departing tail in that next
  // cell instead (see renderDepartingTail), not here.
  pillClasses.push("tr-pill-continues-end");

  // Right-click a booking's own pill strictly offers Split/Merge/Delete
  // (see bookingCellMenuItems) — never the bed-layout actions a plain cell
  // gets, so a bed can't be moved/re-typed out from under an in-progress
  // stay without splitting it first.
  const onContextMenu = (e: React.MouseEvent) => {
    // A pill spans several date columns via one colSpan'd <td> — resolve
    // which exact column was clicked from pointer position (same
    // COLUMN_WIDTH-based day-offset math the drag ghosts use) so "Split
    // Booking on [Date]" offers the right date, not always the arrival date.
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.min(run.length - 1, Math.max(0, Math.floor((e.clientX - rect.left) / COLUMN_WIDTH)));
    const clickDate = run[idx].col.date;
    actions.openMenu(e, booking.guestName, bookingCellMenuItems(first, actions, booking, clickDate));
  };

  const width = COLUMN_WIDTH * run.length;
  const editHref = `/bookings/${booking.id}`;
  // A true check-in occupies only the right half of its column — the left
  // half is that day's turnover for a DIFFERENT (departing) guest, so two
  // guests never visually overlap when they share a bed's calendar day.
  // Arrival day is always part of this run (it's the first occupied
  // night), so insetting it here is enough on its own. The mirror case
  // (checkout) has no equivalent inset on this side — the departure date
  // itself isn't part of this run at all (see the class comment above and
  // renderDepartingTail), so there's nothing to inset.
  const leftInset = startsHere ? COLUMN_WIDTH / 2 : 0;
  // Same-day turnover: this run's own first date is also a DIFFERENT
  // booking's departureDate (see SlotCell.departingBooking) — render that
  // outgoing guest's half-width tail in the left half of this same <td>,
  // flush against this pill's own left inset.
  const departingBooking = startsHere ? cell.departingBooking : undefined;

  return (
    <td
      key={first.col.globalIndex}
      colSpan={run.length}
      rowSpan={first.rowSpan}
      className={classes.join(" ")}
      style={{ width, minWidth: width, maxWidth: width, ...weekendOverlayVars(first.col.date) }}
      onContextMenu={onContextMenu}
      title={`${booking.guestName} - ${formatDateUk(booking.arrivalDate)} to ${formatDateUk(booking.departureDate)}`}
    >
      {departingBooking && renderDepartingTail(departingBooking, actions)}
      <a
        href={editHref}
        draggable={false}
        className={pillClasses.join(" ")}
        // Right edge is always handled by the (now unconditional)
        // tr-pill-continues-end class's `!important` rule, not inline —
        // see the pillClasses comment above.
        style={{ left: leftInset }}
        // Single click is reserved for drag disambiguation — only a
        // double-click (no real drag happened) opens the edit page. A drag
        // that actually moved the pointer is consumed entirely by
        // onPillPointerUp (preventDefault + stopPropagation there), so it
        // never reaches onClick/onDoubleClick at all. Navigation itself goes
        // through Next's client-side router (actions.navigate), not a full
        // page reload.
        onClick={(e) => e.preventDefault()}
        onDoubleClick={(e) => {
          e.preventDefault();
          actions.navigate(editHref);
        }}
        onPointerDown={(e) => onPillPointerDown(e, booking, first.bedId)}
        onPointerMove={onPillPointerMove}
        onPointerUp={(e) => onPillPointerUp(e, actions)}
        onPointerCancel={(e) => onPillPointerUp(e, actions)}
      >
        {!startsHere && (
          <span className="tr-grid-pill-chevron" aria-hidden="true">‹</span>
        )}
        <span className="tr-grid-pill-name">{booking.guestName}</span>
        {!endsHere && (
          <span className="tr-grid-pill-chevron" aria-hidden="true">›</span>
        )}
      </a>
    </td>
  );
}

function renderEventLaneCells(
  lane: GridData["eventLanes"][number],
  visibleColumns: VisibleColumn[],
  dataStartIndex: number,
  actions: GridActions
) {
  const cells: React.ReactNode[] = [];
  let i = 0;
  while (i < visibleColumns.length) {
    const col = visibleColumns[i];
    const band = lane.find((b) => {
      const globalStart = dataStartIndex + b.startIndex;
      const globalEnd = globalStart + b.span;
      return col.globalIndex >= globalStart && col.globalIndex < globalEnd;
    });

    if (!band) {
      cells.push(<td key={col.globalIndex} style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }} />);
      i += 1;
      continue;
    }

    const globalStart = dataStartIndex + band.startIndex;
    const globalEnd = globalStart + band.span;
    let span = 0;
    while (i < visibleColumns.length && visibleColumns[i].globalIndex >= globalStart && visibleColumns[i].globalIndex < globalEnd) {
      span += 1;
      i += 1;
    }

    cells.push(
      <td
        key={`band-${band.event.id}-${col.globalIndex}`}
        colSpan={span}
        className={[
          "tr-grid-event",
          band.continuesBefore ? "tr-grid-event-open-start" : "",
          band.continuesAfter ? "tr-grid-event-open-end" : "",
        ].filter(Boolean).join(" ")}
        style={eventColourStyle(band.event.id)}
        title={`${band.event.name} - ${formatDateUk(band.event.startDate)} to ${formatDateUk(band.event.endDate)}${band.event.notes ? `\n${band.event.notes}` : ""}`}
      >
        <a
          href="/events"
          draggable={false}
          style={{ cursor: "grab", touchAction: "none" }}
          onClick={(e) => {
            // A real drag just finished — don't also follow the link.
            if (suppressNextEventClick) {
              e.preventDefault();
              suppressNextEventClick = false;
            }
          }}
          onPointerDown={(e) =>
            onEventPointerDown(e, {
              id: band.event.id,
              name: band.event.name,
              notes: band.event.notes ?? null,
              startDate: band.event.startDate,
              endDate: band.event.endDate,
            })
          }
          onPointerMove={onEventPointerMove}
          onPointerUp={(e) => onEventPointerUp(e, actions)}
          onPointerCancel={clearEventDragVisuals}
        >
          {band.continuesBefore ? "< " : ""}
          {band.event.name}
          {band.continuesAfter ? " >" : ""}
        </a>
      </td>
    );
  }
  return cells;
}
