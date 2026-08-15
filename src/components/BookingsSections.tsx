"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BookingsTable, { type BookingRow, type Column, DEFAULT_COLUMNS, DEFAULT_COLUMN_WIDTHS } from "@/components/BookingsTable";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import AlertsButton from "@/components/AlertsButton";

const ORDER_STORAGE_KEY = "tr-bookings-column-order";
const VISIBILITY_STORAGE_KEY = "tr-bookings-column-visibility";
const WIDTH_STORAGE_KEY = "tr-bookings-column-widths";
const SPLIT_STORAGE_KEY = "tr-bookings-split-by-arrival";

function loadHiddenKeys(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (!raw) return new Set();
    const keys: string[] = JSON.parse(raw);
    const validKeys = new Set(DEFAULT_COLUMNS.map((c) => c.key as string));
    // guestName always stays visible — it's the link into the booking, hiding
    // it would leave rows with nothing to click.
    return new Set(keys.filter((k) => validKeys.has(k) && k !== "guestName"));
  } catch {
    return new Set();
  }
}

function loadColumnOrder(): Column[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS;
  try {
    const raw = window.localStorage.getItem(ORDER_STORAGE_KEY);
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

function loadColumnWidths(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadSplitByArrival(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
  return raw !== "false";
}

export interface BookingsSection {
  title: string;
  rows: BookingRow[];
  emptyMessage?: string;
}

/**
 * Owns the whole Bookings page header (title, New booking button, Columns
 * menu) as well as column order/visibility/width state for every table on
 * the page — so all of that lives on ONE line instead of the title/button
 * row and the Columns button sitting on separate rows with a big gap
 * between them, and so reordering/resizing/hiding a column in one table is
 * reflected in every other one immediately, since they're really the same
 * columns.
 */
export default function BookingsSections({
  sections,
  guestCategories,
}: {
  sections: BookingsSection[];
  guestCategories: { id: number; name: string; colour: string }[];
}) {
  const router = useRouter();
  const [columns, setColumns] = useState<Column[]>(DEFAULT_COLUMNS);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [splitByArrival, setSplitByArrival] = useState(true);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmModalState | null>(null);
  const [search, setSearch] = useState("");

  // page.tsx (the server component that computes `sections`) re-fetches on
  // navigation but not automatically after a client-side mutation like this
  // delete — router.refresh() re-runs it in place without a full reload, so
  // the deleted row actually disappears instead of needing a manual F5.
  function deleteRow(row: BookingRow) {
    setConfirmState({
      title: "Delete booking?",
      message: `Delete ${row.guestName}'s booking (${row.arrivalDate} to ${row.departureDate})? This can't be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await fetch(`/api/bookings/${row.id}`, { method: "DELETE" });
        router.refresh();
      },
    });
  }

  useEffect(() => {
    setColumns(loadColumnOrder());
    setHiddenKeys(loadHiddenKeys());
    setColumnWidths(loadColumnWidths());
    setSplitByArrival(loadSplitByArrival());
  }, []);

  function persistColumns(next: Column[]) {
    setColumns(next);
    try {
      window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(next.map((c) => c.key)));
    } catch {
      // Storage unavailable (private browsing etc.) — reorder still works
      // for this session, it just won't persist.
    }
  }

  function toggleVisible(key: string) {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(VISIBILITY_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Storage unavailable — visibility still works for this session.
      }
      return next;
    });
  }

  function resizeColumn(key: string, width: number) {
    setColumnWidths((prev) => {
      const next = { ...prev, [key]: width };
      try {
        window.localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable — resize still works for this session.
      }
      return next;
    });
  }

  function updateSplitByArrival(value: boolean) {
    setSplitByArrival(value);
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(value));
    } catch {
      // Storage unavailable — toggle still works for this session.
    }
  }

  // Matches on first name, surname, or preferred name — not the combined
  // "First (Preferred) Last" guestName column text, so e.g. searching
  // "Frabbie" still finds "Frank (Frabbie) Jones" even though "Frabbie"
  // never appears as its own word boundary in that combined string (it
  // does, but matching the raw fields directly is simpler and doesn't rely
  // on displayGuestName's exact formatting staying in sync with this).
  const query = search.trim().toLowerCase();
  function matchesSearch(row: BookingRow): boolean {
    if (!query) return true;
    return (
      row.firstName.toLowerCase().includes(query) ||
      row.lastName.toLowerCase().includes(query) ||
      (row.preferredName?.toLowerCase().includes(query) ?? false)
    );
  }
  const searchedSections: BookingsSection[] = sections.map((s) => ({ ...s, rows: s.rows.filter(matchesSearch) }));

  // With the toggle off, every section's rows just flow into one combined
  // list — still the same underlying rows/order (arriving-soonest first,
  // then the rest), just without the "arriving this week vs. everyone
  // else" heading splitting them up.
  const displaySections: BookingsSection[] = splitByArrival
    ? searchedSections
    : [{ title: "All bookings", rows: searchedSections.flatMap((s) => s.rows) }];

  // The page's own <h1> and the first section's heading used to both say
  // essentially "Bookings" — folded into one line here instead: "Bookings
  // arriving in the next 7 days (N)" when split, just "Bookings" when not
  // (the nav tab itself already makes "which page is this" obvious, so
  // there's no reason for a plain "Bookings" heading to ALSO repeat above
  // a second, more specific one). Every OTHER section (e.g. "Other
  // bookings") still gets its own heading below, same as before — only the
  // first one merges into the page title.
  const [firstSection, ...restSections] = displaySections;
  const pageTitle = splitByArrival
    ? `Bookings ${firstSection.title.charAt(0).toLowerCase()}${firstSection.title.slice(1)} (${firstSection.rows.length})`
    : "Bookings";

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12, flexWrap: "wrap", rowGap: 8 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>{pageTitle}</h1>
        {guestCategories.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginLeft: 16 }}>
            <span className="tr-muted" style={{ fontSize: 12 }}>Guest type:</span>
            {guestCategories.map((c) => (
              <span
                key={c.id}
                className="tr-grid-booking-pill"
                style={{
                  position: "static",
                  ["--tr-booking-color" as string]: c.colour,
                  ["--tr-booking-fill" as string]: `color-mix(in srgb, ${c.colour} 24%, white)`,
                }}
              >
                {c.name}
              </span>
            ))}
          </div>
        )}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search first name, surname or preferred name…"
          aria-label="Search bookings"
          style={{ marginLeft: 16, minWidth: 260 }}
        />
        <span style={{ flex: 1 }} />
        <div style={{ marginRight: 8 }}>
          <AlertsButton onChanged={() => router.refresh()} />
        </div>
        <a href="/bookings/new"><button className="primary">New booking</button></a>
        <div style={{ position: "relative", marginLeft: 8 }}>
          <button type="button" className="tr-columns-trigger" onClick={() => setColumnsMenuOpen((v) => !v)}>
            <span aria-hidden="true" className="tr-columns-trigger-icon">☰</span>
            Columns
          </button>
          {columnsMenuOpen && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 29 }}
                onClick={() => setColumnsMenuOpen(false)}
              />
              <div className="tr-columns-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30 }}>
                <div className="tr-columns-menu-title">Show columns</div>
                {columns.map((col) => {
                  const locked = col.key === "guestName";
                  const checked = !hiddenKeys.has(col.key);
                  return (
                    <label key={col.key} className={locked ? "tr-columns-menu-item tr-columns-menu-item-locked" : "tr-columns-menu-item"}>
                      <span className={checked ? "tr-checkbox tr-checkbox-checked" : "tr-checkbox"} aria-hidden="true">
                        {checked && "✓"}
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={() => toggleVisible(col.key)}
                      />
                      {col.label}
                      {locked && <span className="tr-columns-menu-hint">always shown</span>}
                    </label>
                  );
                })}
                <div className="tr-columns-menu-title">Grouping</div>
                <label className="tr-columns-menu-item">
                  <span className={splitByArrival ? "tr-checkbox tr-checkbox-checked" : "tr-checkbox"} aria-hidden="true">
                    {splitByArrival && "✓"}
                  </span>
                  <input
                    type="checkbox"
                    checked={splitByArrival}
                    onChange={(e) => updateSplitByArrival(e.target.checked)}
                  />
                  Split arriving this week from other bookings
                </label>
              </div>
            </>
          )}
        </div>
      </div>

      {firstSection.rows.length > 0 ? (
        <BookingsTable
          rows={firstSection.rows}
          columns={columns}
          hiddenKeys={hiddenKeys}
          columnWidths={{ ...DEFAULT_COLUMN_WIDTHS, ...columnWidths }}
          onReorderColumns={persistColumns}
          onResizeColumn={resizeColumn}
          onToggleVisible={toggleVisible}
          onDeleteRow={deleteRow}
        />
      ) : (
        <p className="tr-muted" style={{ marginBottom: 16 }}>
          {query ? `No bookings match "${search.trim()}".` : firstSection.emptyMessage ?? "No bookings."}
        </p>
      )}

      {restSections.map((section) => (
        <div key={section.title}>
          <h2 className="tr-section-title" style={{ marginTop: 24, marginBottom: 8 }}>
            {section.title} ({section.rows.length})
          </h2>
          {section.rows.length > 0 ? (
            <BookingsTable
              rows={section.rows}
              columns={columns}
              hiddenKeys={hiddenKeys}
              columnWidths={{ ...DEFAULT_COLUMN_WIDTHS, ...columnWidths }}
              onReorderColumns={persistColumns}
              onResizeColumn={resizeColumn}
              onToggleVisible={toggleVisible}
              onDeleteRow={deleteRow}
            />
          ) : (
            <p className="tr-muted" style={{ marginBottom: 16 }}>
              {query ? `No bookings match "${search.trim()}".` : section.emptyMessage ?? "No bookings."}
            </p>
          )}
        </div>
      ))}
      <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />
    </>
  );
}
