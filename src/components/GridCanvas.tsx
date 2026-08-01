"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import { eventColourStyle, roomColourStyle } from "@/lib/room-colours";
import type { GridData } from "@/lib/grid-data";
import { addDays, type ISODate } from "@/lib/occupancy";
import ToastStack, { type ToastMessage } from "@/components/ToastStack";
import ContextMenu, { type ContextMenuItem, type ContextMenuState } from "@/components/ContextMenu";

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

function weekday(date: ISODate): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function isWeekend(date: ISODate): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function addDaysIso(date: ISODate, days: number): ISODate {
  return addDays(date, days);
}

interface UnassignedBooking {
  guestName: string;
  arrivalDate: string;
  departureDate: string;
}

export default function GridCanvas({ initialData, today }: { initialData: GridData; today: ISODate }) {
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

  function notifyUnassigned(unassignedBookings: UnassignedBooking[] | undefined) {
    if (!unassignedBookings || unassignedBookings.length === 0) return;
    const names = unassignedBookings.map((b) => `${b.guestName} (${b.arrivalDate} to ${b.departureDate})`).join(", ");
    pushToast(
      `This layout change conflicts with ${unassignedBookings.length} existing booking${unassignedBookings.length === 1 ? "" : "s"} — moved to unallocated: ${names}`
    );
  }

  // --- Right-click lifecycle: join / switch / split ----------------------

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  function openMenu(e: React.MouseEvent, title: string, items: ContextMenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, title, items });
  }

  async function apiPost(url: string, body: unknown): Promise<{ unassignedBookings?: UnassignedBooking[] } | null> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return null;
    }
    return res.json();
  }

  async function refreshCurrentWindow() {
    await fetchWindow(data.start, data.days);
  }

  const actions = useMemo(
    () => ({
      openMenu,
      async joinAsNew(bed1Id: number, bed2Id: number, mode: "double" | "solo", atDate: ISODate) {
        const result = await apiPost("/api/joined-beds", { bed1Id, bed2Id, mode, startDate: atDate });
        if (result) {
          notifyUnassigned(result.unassignedBookings);
          await refreshCurrentWindow();
        }
      },
      async switchJoinMode(bed1Id: number, bed2Id: number, atDate: ISODate, mode: "double" | "solo") {
        const result = await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode });
        if (result) {
          notifyUnassigned(result.unassignedBookings);
          await refreshCurrentWindow();
        }
      },
      async splitJoin(bed1Id: number, bed2Id: number, atDate: ISODate) {
        const result = await apiPost("/api/joined-beds/split", { bed1Id, bed2Id, atDate });
        if (result) await refreshCurrentWindow();
      },
      async goSolo(bedId: number, atDate: ISODate) {
        const result = await apiPost("/api/bed-solo-periods", { bedId, startDate: atDate });
        if (result) {
          notifyUnassigned(result.unassignedBookings);
          await refreshCurrentWindow();
        }
      },
      async goCouple(bedId: number, atDate: ISODate) {
        const result = await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
        if (result) await refreshCurrentWindow();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.start, data.days]
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
        <span className="tr-muted" style={{ fontSize: 12 }}>
          {loading ? "Loading…" : `Showing ${formatDateUk(data.start)} to ${formatDateUk(addDaysIso(data.start, data.days - 1))}`}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => jumpToDate(today)}>Today</button>
        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          Jump to
          <input type="date" value={jumpValue} onChange={(e) => setJumpValue(e.target.value)} />
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
                {renderEventLaneCells(lane, visibleColumns, dataStartIndex)}
                {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
              </tr>
            ))}

            {data.grid.map((room, roomIndex) =>
              renderRoomRows(room, roomIndex, visibleColumns, leadingWidth, trailingWidth, actions)
            )}

            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={{ left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH }}>Occupied / beds</td>
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
        Drag anywhere on the grid to pan. Click a free cell to start a new booking. Right-click a Single or Queen bed
        row to join, switch, or split it. Greyed-out cells mean the bed isn&apos;t placed in that room on that date.
      </p>

      {data.alerts.length > 0 && (
        <div className="tr-grid-alerts-corner">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Issues to fix ({data.alerts.length})</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {data.alerts.slice(0, 12).map((a, i) => (
              <li key={`alert-${i}`} style={{ marginBottom: 4 }}>{a}</li>
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
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

// ---------------------------------------------------------------------------

const ROOM_CELL_STYLE = { left: 0, width: ROOM_COL_WIDTH, minWidth: ROOM_COL_WIDTH, maxWidth: ROOM_COL_WIDTH };
const BED_CELL_STYLE = { left: ROOM_COL_WIDTH, width: BED_COL_WIDTH, minWidth: BED_COL_WIDTH, maxWidth: BED_COL_WIDTH };

type VisibleColumn = { globalIndex: number; date: ISODate; dataIndex: number | null };
type SlotCell = import("@/lib/grid").SlotCell;
type GridUnit = import("@/lib/grid").GridUnit;
type RoomGridRow = import("@/lib/grid").RoomGridRow;

interface GridActions {
  openMenu: (e: React.MouseEvent, title: string, items: ContextMenuItem[]) => void;
  joinAsNew: (bed1Id: number, bed2Id: number, mode: "double" | "solo", atDate: ISODate) => void;
  switchJoinMode: (bed1Id: number, bed2Id: number, atDate: ISODate, mode: "double" | "solo") => void;
  splitJoin: (bed1Id: number, bed2Id: number, atDate: ISODate) => void;
  goSolo: (bedId: number, atDate: ISODate) => void;
  goCouple: (bedId: number, atDate: ISODate) => void;
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
      rows.push(...renderPairedBlock(room, roomIndex, unit, next, isFirstRoomRow, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      i += 1;
      continue;
    }

    const isNativePair = unit.slots.length === 2;
    if (isNativePair) {
      const isFirstRoomRow = roomRowsRendered === 0;
      rows.push(...renderNativePairBlock(room, roomIndex, unit, isFirstRoomRow, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      continue;
    }

    const isSingle = unit.label.toLowerCase() === "single";
    const nextIsPairableSingle = !!next && next.partnerUnitKey == null && next.slots.length === 1 && next.label.toLowerCase() === "single";
    if (isSingle && unit.partnerUnitKey == null && nextIsPairableSingle && next) {
      const isFirstRoomRow = roomRowsRendered === 0;
      rows.push(...renderPairableSinglesBlock(room, roomIndex, unit, next, isFirstRoomRow, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      i += 1;
      continue;
    }

    for (let slotIndex = 0; slotIndex < unit.slots.length; slotIndex++) {
      const slot = unit.slots[slotIndex];
      const isFirstRoomRow = roomRowsRendered === 0;
      roomRowsRendered += 1;
      const isFirstUnitRow = slotIndex === 0;

      rows.push(
        <tr key={`${unit.key}-${slotIndex}`} className={isFirstRoomRow ? "tr-grid-room-start" : undefined} style={roomColourStyle(roomIndex)}>
          {isFirstRoomRow && (
            <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
              <div style={{ fontWeight: 600 }}>{room.roomName}</div>
              <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
            </td>
          )}
          {isFirstUnitRow && (
            <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={unit.slots.length}>
              {unit.label}
            </td>
          )}
          {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
          {visibleColumns.map((col) => {
            const cell = col.dataIndex != null ? slot.cells[col.dataIndex] : null;
            return renderGridCell(cell, col, unit.bedId, room.roomName, {});
          })}
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
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unitA.slots[0];
  const slotB = unitB.slots[0];
  const rowACells: React.ReactNode[] = [];
  const rowBCells: React.ReactNode[] = [];
  let previousWasSolo = false;

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
      // The "Solo Double" label only needs to appear once at the start of a
      // run of merged dates — repeating it in every column was the clutter
      // being reported. The tint (tr-grid-solo-merged) alone carries the
      // state for the rest of the run.
      rowACells.push(
        renderSoloMergedCell(primaryCell, col, primaryBedId, room.roomName, !previousWasSolo, actions, "Solo Double", menu)
      );
      // unitB renders nothing here — consumed by unitA's rowSpan.
    } else {
      const menu: ContextMenuItem[] = mode
        ? [
            { label: mode === "double" ? "Switch to Solo Double" : "Switch to Couple Double", onClick: () => actions.switchJoinMode(unitA.bedId, unitB.bedId, col.date, mode === "double" ? "solo" : "double") },
            { label: "Split into Singles", onClick: () => actions.splitJoin(unitA.bedId, unitB.bedId, col.date), danger: true },
          ]
        : [
            { label: "Join as Couple Double", onClick: () => actions.joinAsNew(unitA.bedId, unitB.bedId, "double", col.date) },
            { label: "Join as Solo Double", onClick: () => actions.joinAsNew(unitA.bedId, unitB.bedId, "solo", col.date) },
          ];
      const rowAMenu = bothActive ? { title: `${room.roomName} — Single beds`, items: menu } : undefined;
      rowACells.push(
        renderGridCell(cellA, col, unitA.bedId, room.roomName, {
          dividerStyle: mode === "double" ? "dashed" : "solid",
          menu: rowAMenu,
          openMenu: actions.openMenu,
        })
      );
      rowBCells.push(renderGridCell(cellB, col, unitB.bedId, room.roomName, {}));
    }
    previousWasSolo = soloActive;
  }

  return [
    <tr key={`${unitA.key}-paired`} className={isFirstRoomRow ? "tr-grid-room-start" : undefined} style={roomColourStyle(roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
          <div style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={1}>{unitA.label}</td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {rowACells}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unitB.key}-paired`} style={roomColourStyle(roomIndex)}>
      <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={1}>{unitB.label}</td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {rowBCells}
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
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unit.slots[0];
  const slotB = unit.slots[1];
  const rowACells: React.ReactNode[] = [];
  const rowBCells: React.ReactNode[] = [];
  let previousWasSolo = false;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const active = cellA && cellA.state !== "inactive";
    const soloActive = active && col.dataIndex != null && !!unit.soloByDate?.[col.dataIndex];

    if (soloActive && cellA) {
      const menu: ContextMenuItem[] = [
        { label: `Switch to Couple ${unit.label}`, onClick: () => actions.goCouple(unit.bedId, col.date), danger: true },
      ];
      rowACells.push(
        renderSoloMergedCell(cellA, col, unit.bedId, room.roomName, !previousWasSolo, actions, `Solo ${unit.label}`, menu)
      );
    } else {
      const menu: ContextMenuItem[] | undefined = active
        ? [{ label: `Switch to Solo ${unit.label}`, onClick: () => actions.goSolo(unit.bedId, col.date) }]
        : undefined;
      rowACells.push(
        renderGridCell(cellA, col, unit.bedId, room.roomName, {
          dividerStyle: active ? "dashed" : undefined,
          menu: menu ? { title: `${room.roomName} — ${unit.label}`, items: menu } : undefined,
          openMenu: actions.openMenu,
        })
      );
      rowBCells.push(renderGridCell(cellB, col, unit.bedId, room.roomName, {}));
    }
    previousWasSolo = !!soloActive;
  }

  return [
    <tr key={`${unit.key}-native-a`} className={isFirstRoomRow ? "tr-grid-room-start" : undefined} style={roomColourStyle(roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
          <div style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={1}>{unit.label}</td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {rowACells}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unit.key}-native-b`} style={roomColourStyle(roomIndex)}>
      <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={1}>{unit.label}</td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {rowBCells}
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
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unitA.slots[0];
  const slotB = unitB.slots[0];
  const rowACells: React.ReactNode[] = [];
  const rowBCells: React.ReactNode[] = [];

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const bothActive = cellA && cellA.state !== "inactive" && cellB && cellB.state !== "inactive";
    const menu: ContextMenuItem[] = [
      { label: "Join as Couple Double", onClick: () => actions.joinAsNew(unitA.bedId, unitB.bedId, "double", col.date) },
      { label: "Join as Solo Double", onClick: () => actions.joinAsNew(unitA.bedId, unitB.bedId, "solo", col.date) },
    ];
    const sharedMenu = bothActive ? { title: `${room.roomName} — Single beds`, items: menu } : undefined;

    rowACells.push(
      renderGridCell(cellA, col, unitA.bedId, room.roomName, { dividerStyle: "solid", menu: sharedMenu, openMenu: actions.openMenu })
    );
    rowBCells.push(
      renderGridCell(cellB, col, unitB.bedId, room.roomName, { menu: sharedMenu, openMenu: actions.openMenu })
    );
  }

  return [
    <tr key={`${unitA.key}-pairable`} className={isFirstRoomRow ? "tr-grid-room-start" : undefined} style={roomColourStyle(roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={ROOM_CELL_STYLE} rowSpan={roomRowCount}>
          <div style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={1}>{unitA.label}</td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {rowACells}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unitB.key}-pairable`} style={roomColourStyle(roomIndex)}>
      <td className="tr-grid-bed" style={BED_CELL_STYLE} rowSpan={1}>{unitB.label}</td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {rowBCells}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

/**
 * One merged cell (e.g. "Solo Double" / "Solo Queen") spanning both of a
 * pair's rows for one date. `showLabel` is only true on the first column of
 * a visible merged run — every other date just carries the tint, not the
 * text, so a long solo stretch doesn't stamp the label into every day.
 */
function renderSoloMergedCell(
  cell: SlotCell,
  col: VisibleColumn,
  bedId: number,
  roomName: string,
  showLabel: boolean,
  actions: GridActions,
  label: string,
  menuItems: ContextMenuItem[]
) {
  const classes = ["tr-grid-cell", "tr-grid-solo-merged"];
  if (isWeekend(col.date)) classes.push("tr-grid-weekend");
  if (cell.state === "booked") {
    classes.push("tr-grid-occupied");
    if (cell.isArrival) classes.push("tr-grid-arrival");
    if (cell.isDeparture) classes.push("tr-grid-departure");
  }

  return (
    <td
      key={col.globalIndex}
      rowSpan={2}
      className={classes.join(" ")}
      style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }}
      title={
        cell.state === "booked" && cell.booking
          ? `${cell.booking.guestName} - ${formatDateUk(cell.booking.arrivalDate)} to ${formatDateUk(cell.booking.departureDate)} (${label})`
          : `New booking - ${roomName}, ${label}, night of ${formatDateUk(col.date)}`
      }
      onContextMenu={(e) => actions.openMenu(e, `${roomName} — ${label}`, menuItems)}
    >
      {cell.state === "booked" && cell.booking ? (
        <a href={`/bookings/${cell.booking.id}`} draggable={false}>
          {cell.booking.guestName}
          {cell.isArrival ? " <" : cell.isDeparture ? " /" : ""}
        </a>
      ) : (
        <a
          className={showLabel ? "tr-grid-solo-new" : "tr-grid-new"}
          draggable={false}
          href={`/bookings/new?bedId=${bedId}&arrival=${col.date}&departure=${addDaysIso(col.date, 1)}`}
        >
          {showLabel ? label : "+"}
        </a>
      )}
    </td>
  );
}

interface CellOptions {
  /** Border-bottom treatment — set only on the "top" row of a 2-row block. */
  dividerStyle?: "solid" | "dashed";
  menu?: { title: string; items: ContextMenuItem[] };
  openMenu?: (e: React.MouseEvent, title: string, items: ContextMenuItem[]) => void;
}

function renderGridCell(cell: SlotCell | null, col: VisibleColumn, bedId: number, roomName: string, options: CellOptions) {
  const dividerClass = options.dividerStyle === "dashed" ? "tr-grid-divider-dashed" : options.dividerStyle === "solid" ? "tr-grid-divider-solid" : "";

  if (!cell) {
    return (
      <td
        key={col.globalIndex}
        className={["tr-grid-cell", "tr-grid-inactive", dividerClass].filter(Boolean).join(" ")}
        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }}
        title="Loading…"
      />
    );
  }

  const classes = ["tr-grid-cell"];
  if (isWeekend(col.date)) classes.push("tr-grid-weekend");
  if (dividerClass) classes.push(dividerClass);

  if (cell.state === "inactive") {
    classes.push("tr-grid-inactive");
  } else if (cell.state === "booked") {
    classes.push("tr-grid-occupied");
    if (cell.isArrival) classes.push("tr-grid-arrival");
    if (cell.isDeparture) classes.push("tr-grid-departure");
  }

  const onContextMenu = options.menu && options.openMenu
    ? (e: React.MouseEvent) => options.openMenu!(e, options.menu!.title, options.menu!.items)
    : undefined;

  if (cell.state === "inactive") {
    return (
      <td
        key={col.globalIndex}
        className={classes.join(" ")}
        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }}
        title="Not placed in this room on this date"
      />
    );
  }

  return (
    <td
      key={col.globalIndex}
      className={classes.join(" ")}
      style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }}
      onContextMenu={onContextMenu}
      title={
        cell.state === "booked" && cell.booking
          ? `${cell.booking.guestName} - ${formatDateUk(cell.booking.arrivalDate)} to ${formatDateUk(cell.booking.departureDate)}`
          : `New booking - ${roomName}, night of ${formatDateUk(col.date)}`
      }
    >
      {cell.state === "booked" && cell.booking ? (
        <a href={`/bookings/${cell.booking.id}`} draggable={false}>
          {cell.booking.guestName}
          {cell.isArrival ? " <" : cell.isDeparture ? " /" : ""}
        </a>
      ) : (
        <a className="tr-grid-new" draggable={false} href={`/bookings/new?bedId=${bedId}&arrival=${col.date}&departure=${addDaysIso(col.date, 1)}`}>
          +
        </a>
      )}
    </td>
  );
}

function renderEventLaneCells(
  lane: GridData["eventLanes"][number],
  visibleColumns: VisibleColumn[],
  dataStartIndex: number
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
        <a href="/events" draggable={false}>
          {band.continuesBefore ? "< " : ""}
          {band.event.name}
          {band.continuesAfter ? " >" : ""}
        </a>
      </td>
    );
  }
  return cells;
}
