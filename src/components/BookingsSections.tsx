"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BookingsTable, { type BookingRow, type Column, DEFAULT_COLUMNS, DEFAULT_COLUMN_WIDTHS } from "@/components/BookingsTable";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import AlertsButton from "@/components/AlertsButton";
import { pillColourVars } from "@/lib/pill-colour";

const ORDER_STORAGE_KEY = "tr-bookings-column-order";
const VISIBILITY_STORAGE_KEY = "tr-bookings-column-visibility";
const WIDTH_STORAGE_KEY = "tr-bookings-column-widths";
const SPLIT_STORAGE_KEY = "tr-bookings-split-by-arrival";
// Remembers the in-progress search so clicking into a booking from the
// results and coming back (a real navigation — unmounts this component)
// lands back on the same results, not the whole unfiltered page. sessionStorage
// (not localStorage): scoped to this tab, like the grid's own remembered
// position — see GridCanvas.tsx's GRID_VIEW_STATE_KEY for the same reasoning.
const SEARCH_STORAGE_KEY = "tr-bookings-search";

function loadSearch(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(SEARCH_STORAGE_KEY) ?? "";
}

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
  const [search, setSearch] = useState(loadSearch);
  const [searchResults, setSearchResults] = useState<BookingRow[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

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

  useEffect(() => {
    try {
      window.sessionStorage.setItem(SEARCH_STORAGE_KEY, search);
    } catch {
      // Storage unavailable — search still works for this session.
    }
  }, [search]);

  // Debounced search against /api/bookings/search — a real server query
  // (not a client-side filter) so it can reach bookings outside the page's
  // own most-recent-200, i.e. actually search the whole history rather than
  // whatever happened to already be loaded. `active` + AbortController both
  // guard against a slow earlier request clobbering a newer, faster one.
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/bookings/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!active) return;
        const rows: BookingRow[] = res.ok ? await res.json() : [];
        setSearchResults(rows);
      } catch {
        if (active) setSearchResults([]);
      } finally {
        if (active) setSearchLoading(false);
      }
    }, 300);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [search]);

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

  // With the toggle off, every section's rows just flow into one combined
  // list — still the same underlying rows/order (arriving-soonest first,
  // then the rest), just without the "arriving this week vs. everyone
  // else" heading splitting them up.
  const displaySections: BookingsSection[] = splitByArrival
    ? sections
    : [{ title: "All bookings", rows: sections.flatMap((s) => s.rows) }];

  // Searching hits a dedicated endpoint (see the effect below) rather than
  // filtering `sections` client-side, since `sections` only ever holds the
  // page's own most-recent-200 bookings — a plain client filter could never
  // find anything older than that. While a search is active, it fully
  // replaces the normal arrival-week grouping with one flat results list
  // (mixing past/future/whatever matched doesn't fit neatly into "arriving
  // this week" vs "other bookings" anyway).
  const query = search.trim();
  const searching = query.length > 0;

  // The page's own <h1> and the first section's heading used to both say
  // essentially "Bookings" — folded into one line here instead: "Bookings
  // arriving in the next 7 days (N)" when split, just "Bookings" when not
  // (the nav tab itself already makes "which page is this" obvious, so
  // there's no reason for a plain "Bookings" heading to ALSO repeat above
  // a second, more specific one). Every OTHER section (e.g. "Other
  // bookings") still gets its own heading below, same as before — only the
  // first one merges into the page title.
  const [firstSection, ...restSections] = displaySections;
  const pageTitle = searching
    ? "Bookings"
    : splitByArrival
      ? `Bookings ${firstSection.title.charAt(0).toLowerCase()}${firstSection.title.slice(1)} (${firstSection.rows.length})`
      : "Bookings";

  return (
    <>
      {/* Never overflows the page width: the outer row wraps, so the
          search+buttons cluster drops to its own line under the title
          when there isn't room, instead of scrolling or spilling out. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", marginBottom: 12, rowGap: 8, columnGap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 6, columnGap: 16, flex: "1 1 auto", minWidth: 0 }}>
          <h1 style={{ fontSize: 18, margin: 0, flex: "none", whiteSpace: "nowrap" }}>{pageTitle}</h1>
          {guestCategories.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 6, columnGap: 6, flex: "none" }}>
              <span className="tr-muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>Guest type:</span>
              {guestCategories.map((c) => (
                <span key={c.id} className="tr-grid-booking-pill" style={{ position: "static", flex: "none", whiteSpace: "nowrap", ...pillColourVars(c.colour) }}>
                  {c.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search first name, surname or preferred name…"
            aria-label="Search bookings"
            style={{ flex: "1 1 160px", minWidth: 0, maxWidth: 240 }}
          />
          <AlertsButton onChanged={() => router.refresh()} />
          <a href="/bookings/new" style={{ flexShrink: 0 }}><button className="primary">New booking</button></a>
          <div style={{ position: "relative", flexShrink: 0 }}>
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
      </div>

      {searching ? (
        <div>
          <h2 className="tr-section-title" style={{ marginBottom: 8 }}>
            Search results {searchLoading ? "" : `(${searchResults.length})`}
          </h2>
          {searchLoading ? (
            <p className="tr-muted" style={{ marginBottom: 16 }}>Searching…</p>
          ) : searchResults.length > 0 ? (
            <BookingsTable
              rows={searchResults}
              columns={columns}
              hiddenKeys={hiddenKeys}
              columnWidths={{ ...DEFAULT_COLUMN_WIDTHS, ...columnWidths }}
              onReorderColumns={persistColumns}
              onResizeColumn={resizeColumn}
              onToggleVisible={toggleVisible}
              onDeleteRow={deleteRow}
            />
          ) : (
            <p className="tr-muted" style={{ marginBottom: 16 }}>No bookings match &quot;{query}&quot;.</p>
          )}
        </div>
      ) : (
        <>
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
            <p className="tr-muted" style={{ marginBottom: 16 }}>{firstSection.emptyMessage ?? "No bookings."}</p>
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
                <p className="tr-muted" style={{ marginBottom: 16 }}>{section.emptyMessage ?? "No bookings."}</p>
              )}
            </div>
          ))}
        </>
      )}
      <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />
    </>
  );
}
