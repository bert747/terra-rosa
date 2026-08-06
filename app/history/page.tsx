"use client";

import { useEffect, useState } from "react";

interface ChangeLogEntry {
  id: number;
  createdAt: string;
  userName: string;
  category: "grid" | "bookings" | "events" | "layout";
  action: string;
  summary: string;
}

const CATEGORY_LABELS: Record<ChangeLogEntry["category"], string> = {
  grid: "Grid",
  bookings: "Bookings",
  events: "Events",
  layout: "Layout",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as ChangeLogEntry["category"][];

export default function HistoryPage() {
  const [entries, setEntries] = useState<ChangeLogEntry[]>([]);
  // All ticked by default (== no filter, same as the old "All changes"
  // option) — a row of checkboxes you can combine (tick Grid AND Bookings
  // to see both together) instead of a dropdown that only ever shows one
  // category at a time.
  const [checked, setChecked] = useState<Set<ChangeLogEntry["category"]>>(new Set(ALL_CATEGORIES));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function toggleCategory(cat: ChangeLogEntry["category"]) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  useEffect(() => {
    // Nothing ticked means nothing to show — don't silently fall back to
    // "no filter" (which would look like the checkboxes aren't working).
    if (checked.size === 0) {
      setEntries([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    // Every category ticked is equivalent to none ticked in API terms (both
    // mean "no filter" server-side) — only send params when it's a genuine
    // subset, so a fresh "everything on" load still hits the plain,
    // unfiltered endpoint.
    const params = checked.size < ALL_CATEGORIES.length ? `?${[...checked].map((c) => `category=${c}`).join("&")}` : "";
    fetch(`/api/change-log${params}`)
      .then((r) => {
        if (!r.ok) throw new Error("Could not load history.");
        return r.json();
      })
      .then((rows: ChangeLogEntry[]) => setEntries(rows))
      .catch(() => setError("Could not load history."))
      .finally(() => setLoading(false));
  }, [checked]);

  return (
    <div className="tr-shell">
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 className="tr-page-title" style={{ margin: 0 }}>History</h1>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {ALL_CATEGORIES.map((cat) => (
            <label key={cat} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={checked.has(cat)} onChange={() => toggleCategory(cat)} />
              {CATEGORY_LABELS[cat]}
            </label>
          ))}
        </div>
      </div>

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card" style={{ padding: 0, overflow: "hidden" }}>
        {loading ? (
          <p className="tr-muted" style={{ padding: 16 }}>Loading…</p>
        ) : entries.length === 0 ? (
          <p className="tr-muted" style={{ padding: 16 }}>No changes recorded yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 1, whiteSpace: "nowrap" }}>When</th>
                <th style={{ width: 1, whiteSpace: "nowrap" }}>Who</th>
                <th style={{ width: 1, whiteSpace: "nowrap" }}>Area</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="tr-muted" style={{ whiteSpace: "nowrap" }}>{formatTimestamp(entry.createdAt)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{entry.userName}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{CATEGORY_LABELS[entry.category]}</td>
                  <td>{entry.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {entries.length >= 100 && (
        <p className="tr-muted" style={{ fontSize: 12, marginTop: 8 }}>
          Showing the most recent 100 changes.
        </p>
      )}
    </div>
  );
}
