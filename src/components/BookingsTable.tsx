"use client";

import { useMemo, useRef, useState } from "react";
import ContextMenu, { type ContextMenuItem, type ContextMenuState } from "@/components/ContextMenu";

export interface BookingRow {
  id: number;
  guestName: string;
  roomName: string;
  arrivalDate: string;
  departureDate: string;
  stayLength: string;
  sharesWith: string;
  bedType: string;
  guestType: string;
  dietary: string;
}

export interface Column {
  key: keyof Omit<BookingRow, "id">;
  label: string;
}

export const DEFAULT_COLUMNS: Column[] = [
  { key: "guestName", label: "Guest" },
  { key: "roomName", label: "Room" },
  { key: "arrivalDate", label: "Arrival" },
  { key: "departureDate", label: "Departure" },
  { key: "stayLength", label: "Nights" },
  { key: "sharesWith", label: "Shares with" },
  { key: "bedType", label: "Bed Type" },
  { key: "guestType", label: "Guest Type" },
  { key: "dietary", label: "Dietary" },
];

export const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  guestName: 160,
  roomName: 130,
  arrivalDate: 100,
  departureDate: 100,
  stayLength: 70,
  sharesWith: 220,
  bedType: 130,
  guestType: 110,
  dietary: 200,
};

const MIN_COLUMN_WIDTH = 50;

let measureCtx: CanvasRenderingContext2D | null = null;
function measureTextWidth(text: string, font: string): number {
  if (typeof document === "undefined") return text.length * 7;
  if (!measureCtx) {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/**
 * Widest cell (header label or any row's value) in this column, plus padding
 * for the drag handle/sort icon in the header — used for double-click
 * autofit. Deliberately only measures the rows this particular table
 * instance has (upcoming vs. later), since that's what's actually visible.
 */
function autofitWidth(col: Column, rows: BookingRow[]): number {
  const headerWidth = measureTextWidth(col.label, "600 13px system-ui, sans-serif") + 50; // grip + sort icon + gaps
  let maxCellWidth = 0;
  for (const row of rows) {
    const w = measureTextWidth(String(row[col.key]), "13px system-ui, sans-serif");
    if (w > maxCellWidth) maxCellWidth = w;
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.round(Math.max(headerWidth, maxCellWidth + 24)));
}

interface BookingsTableProps {
  rows: BookingRow[];
  columns: Column[];
  hiddenKeys: Set<string>;
  columnWidths: Record<string, number>;
  onReorderColumns: (next: Column[]) => void;
  onResizeColumn: (key: string, width: number) => void;
  onToggleVisible: (key: string) => void;
  onDeleteRow: (row: BookingRow) => void;
}

/**
 * Bookings table with drag-and-drop column reordering and drag-to-resize /
 * double-click-to-autofit column widths. No drag library in this repo (see
 * GridCanvas.tsx's hand-rolled Pointer Events for the same reason) — reorder
 * uses plain HTML5 drag events, resize uses Pointer Events directly since it
 * needs continuous movement, not a single drop target.
 *
 * Column order/visibility/widths are all owned by the parent (see
 * BookingsSections) so multiple table instances on one page share a single
 * "Columns" control instead of each carrying its own.
 */
export default function BookingsTable({
  rows,
  columns,
  hiddenKeys,
  columnWidths,
  onReorderColumns,
  onResizeColumn,
  onToggleVisible,
  onDeleteRow,
}: BookingsTableProps) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<Column["key"] | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const resizeRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const visibleColumns = useMemo(() => columns.filter((c) => !hiddenKeys.has(c.key)), [columns, hiddenKeys]);
  const tableWidth = useMemo(
    () => visibleColumns.reduce((sum, c) => sum + (columnWidths[c.key] ?? DEFAULT_COLUMN_WIDTHS[c.key] ?? 120), 0),
    [visibleColumns, columnWidths]
  );

  // Three-state cycle per column: unsorted -> asc -> desc -> unsorted.
  // Clicking a different column always restarts that cycle at asc.
  function toggleSort(key: Column["key"]) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(null);
    }
  }

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const sorted = [...rows].sort((a, b) => {
      const cmp = String(a[sortKey]).localeCompare(String(b[sortKey]), undefined, { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, sortKey, sortDir]);

  function openColumnMenu(e: React.MouseEvent, col: Column) {
    e.preventDefault();
    const items: ContextMenuItem[] = [
      { label: "Sort A → Z", onClick: () => { setSortKey(col.key); setSortDir("asc"); } },
      { label: "Sort Z → A", onClick: () => { setSortKey(col.key); setSortDir("desc"); } },
    ];
    if (col.key !== "guestName") {
      items.push({ label: "Hide column", onClick: () => onToggleVisible(col.key) });
    }
    setContextMenu({ x: e.clientX, y: e.clientY, title: col.label, items });
  }

  function openRowMenu(e: React.MouseEvent, row: BookingRow) {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      title: row.guestName,
      items: [{ label: "Delete booking", danger: true, onClick: () => onDeleteRow(row) }],
    });
  }

  function handleDrop(targetKey: string) {
    setDragOverKey(null);
    if (!dragKey || dragKey === targetKey) return;
    const next = [...columns];
    const fromIndex = next.findIndex((c) => c.key === dragKey);
    const toIndex = next.findIndex((c) => c.key === targetKey);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorderColumns(next);
    setDragKey(null);
  }

  function startResize(e: React.PointerEvent, col: Column) {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = columnWidths[col.key] ?? DEFAULT_COLUMN_WIDTHS[col.key] ?? 120;
    resizeRef.current = { key: col.key, startX: e.clientX, startWidth };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handleResizeMove(e: React.PointerEvent) {
    const state = resizeRef.current;
    if (!state) return;
    const next = Math.max(MIN_COLUMN_WIDTH, Math.round(state.startWidth + (e.clientX - state.startX)));
    onResizeColumn(state.key, next);
  }

  function endResize(e: React.PointerEvent) {
    if (!resizeRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    resizeRef.current = null;
  }

  return (
    <div className="tr-card" style={{ overflowX: "auto" }}>
      <table style={{ tableLayout: "fixed", width: tableWidth, minWidth: "100%" }}>
        <thead>
          <tr>
            {visibleColumns.map((col) => {
              const width = columnWidths[col.key] ?? DEFAULT_COLUMN_WIDTHS[col.key] ?? 120;
              return (
                <th
                  key={col.key}
                  draggable
                  onDragStart={(e) => {
                    // Firefox refuses to start a drag at all unless data is
                    // set here — Chrome/Safari don't strictly need it, but
                    // setting it keeps this working across all three.
                    e.dataTransfer?.setData("text/plain", col.key);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    setDragKey(col.key);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                    if (dragOverKey !== col.key) setDragOverKey(col.key);
                  }}
                  onDragLeave={() => setDragOverKey((k) => (k === col.key ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(col.key);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setDragOverKey(null);
                  }}
                  onContextMenu={(e) => openColumnMenu(e, col)}
                  style={{
                    position: "relative",
                    cursor: "grab",
                    userSelect: "none",
                    width,
                    opacity: dragKey === col.key ? 0.4 : 1,
                    background: dragOverKey === col.key && dragKey !== col.key ? "var(--tr-accent-soft)" : undefined,
                    boxShadow: dragOverKey === col.key && dragKey !== col.key ? "inset 2px 0 0 var(--tr-accent)" : undefined,
                  }}
                  data-tooltip="Drag to reorder — right-click to sort or hide — drag the right edge to resize"
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, maxWidth: "100%", overflow: "hidden" }}>
                    <span aria-hidden="true" style={{ opacity: 0.45, fontSize: 11, letterSpacing: "-1px" }}>⠿</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{col.label}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        // Sorting is a click, not a drag — stop it from also
                        // being read as the start of a column-reorder drag.
                        e.stopPropagation();
                        toggleSort(col.key);
                      }}
                      aria-label={`Sort by ${col.label}`}
                      data-tooltip={`Sort by ${col.label}`}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        margin: 0,
                        cursor: "pointer",
                        fontSize: 10,
                        lineHeight: 1,
                        opacity: sortKey === col.key ? 1 : 0.35,
                        flexShrink: 0,
                      }}
                    >
                      {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : "▲▼"}
                    </button>
                  </span>
                  <span
                    onPointerDown={(e) => startResize(e, col)}
                    onPointerMove={handleResizeMove}
                    onPointerUp={endResize}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onResizeColumn(col.key, autofitWidth(col, rows));
                    }}
                    data-tooltip="Drag to resize — double-click to fit content"
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      bottom: 0,
                      width: 8,
                      cursor: "col-resize",
                      touchAction: "none",
                    }}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.id} className="tr-row-link" onContextMenu={(e) => openRowMenu(e, row)}>
              {visibleColumns.map((col) => (
                <td
                  key={col.key}
                  data-tooltip={col.key === "dietary" ? row.dietary : undefined}
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  <a className="tr-cell-link" href={`/bookings/${row.id}`}>
                    {row[col.key]}
                  </a>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
    </div>
  );
}
