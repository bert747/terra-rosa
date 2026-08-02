"use client";

import { useEffect, useMemo, useState } from "react";

export interface BookingRow {
  id: number;
  guestName: string;
  roomName: string;
  arrivalDate: string;
  departureDate: string;
  sleepsNear: string;
  bedType: string;
  guestType: string;
  dietary: string;
}

interface Column {
  key: keyof Omit<BookingRow, "id">;
  label: string;
}

const DEFAULT_COLUMNS: Column[] = [
  { key: "guestName", label: "Guest" },
  { key: "roomName", label: "Room" },
  { key: "arrivalDate", label: "Arrival" },
  { key: "departureDate", label: "Departure" },
  { key: "sleepsNear", label: "Sleeps near" },
  { key: "bedType", label: "Bed Type" },
  { key: "guestType", label: "Guest Type" },
  { key: "dietary", label: "Dietary" },
];

const STORAGE_KEY = "tr-bookings-column-order";

function loadColumnOrder(): Column[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMNS;
    const keys: string[] = JSON.parse(raw);
    const byKey = new Map(DEFAULT_COLUMNS.map((c) => [c.key, c]));
    const restored = keys.map((k) => byKey.get(k as Column["key"])).filter((c): c is Column => c != null);
    // If storage is stale (a column was added/removed since it was saved),
    // fall back to the default order rather than showing a partial table.
    if (restored.length !== DEFAULT_COLUMNS.length) return DEFAULT_COLUMNS;
    return restored;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

/**
 * Bookings table with drag-and-drop column reordering. No drag library in
 * this repo (see GridCanvas.tsx's hand-rolled Pointer Events for the same
 * reason) — this uses plain HTML5 drag events on the <th> cells instead,
 * since a header-only reorder doesn't need pointer-capture/ghost-element
 * tricks. Column order persists to localStorage so it survives a reload.
 */
export default function BookingsTable({ rows }: { rows: BookingRow[] }) {
  const [columns, setColumns] = useState<Column[]>(DEFAULT_COLUMNS);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<Column["key"] | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    setColumns(loadColumnOrder());
  }, []);

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

  function persist(next: Column[]) {
    setColumns(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.map((c) => c.key)));
    } catch {
      // Storage unavailable (private browsing etc.) — reorder still works
      // for this session, it just won't persist.
    }
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
    persist(next);
    setDragKey(null);
  }

  return (
    <div className="tr-card" style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
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
                style={{
                  cursor: "grab",
                  userSelect: "none",
                  opacity: dragKey === col.key ? 0.4 : 1,
                  background: dragOverKey === col.key && dragKey !== col.key ? "var(--tr-accent-soft)" : undefined,
                  boxShadow: dragOverKey === col.key && dragKey !== col.key ? "inset 2px 0 0 var(--tr-accent)" : undefined,
                }}
                title="Drag to reorder columns"
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span aria-hidden="true" style={{ opacity: 0.45, fontSize: 11, letterSpacing: "-1px" }}>⠿</span>
                  {col.label}
                  <button
                    type="button"
                    onClick={(e) => {
                      // Sorting is a click, not a drag — stop it from also
                      // being read as the start of a column-reorder drag.
                      e.stopPropagation();
                      toggleSort(col.key);
                    }}
                    aria-label={`Sort by ${col.label}`}
                    title={`Sort by ${col.label}`}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      cursor: "pointer",
                      fontSize: 10,
                      lineHeight: 1,
                      opacity: sortKey === col.key ? 1 : 0.35,
                    }}
                  >
                    {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : "▲▼"}
                  </button>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.id} className="tr-row-link">
              {columns.map((col) => (
                <td key={col.key} title={col.key === "dietary" ? row.dietary : undefined}>
                  <a className="tr-cell-link" href={`/bookings/${row.id}`}>
                    {row[col.key]}
                  </a>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
