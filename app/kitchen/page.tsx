"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import { addDays, type ISODate } from "@/lib/occupancy";
import { guestsForMeal, aggregateDietaryTags, type MealBooking, type MealType } from "@/lib/kitchen";
import DateField from "@/components/DateField";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_WINDOW_DAYS = 7;
// Guards against an accidental multi-year range rendering a huge table.
const MAX_WINDOW_DAYS = 62;
const MEALS: { key: MealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
];

function todayIso(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

function weekday(date: ISODate): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

interface DailyNote {
  id: number;
  date: ISODate;
  notes: string | null;
}

export default function KitchenPrepMatrixPage() {
  const [fromDate, setFromDate] = useState<ISODate>(todayIso);
  const [toDate, setToDate] = useState<ISODate>(() => addDays(todayIso(), DEFAULT_WINDOW_DAYS - 1));
  const [bookings, setBookings] = useState<MealBooking[]>([]);
  const [notesByDate, setNotesByDate] = useState<Map<ISODate, DailyNote>>(new Map());
  const [noteModalDate, setNoteModalDate] = useState<ISODate | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadBookings() {
    const rows = (await fetch("/api/bookings").then((r) => r.json())) as MealBooking[];
    setBookings(rows);
  }

  async function loadNotes() {
    const rows = (await fetch("/api/daily-meal-notes").then((r) => r.json())) as DailyNote[];
    setNotesByDate(new Map(rows.map((r) => [r.date, r])));
  }

  useEffect(() => {
    loadBookings();
    loadNotes();
  }, []);

  const dates = useMemo(() => {
    const span = Math.min(MAX_WINDOW_DAYS, Math.max(1, nightsBetween(fromDate, toDate) + 1));
    return Array.from({ length: span }, (_, i) => addDays(fromDate, i));
  }, [fromDate, toDate]);

  function shiftRange(days: number) {
    setFromDate((d) => addDays(d, days));
    setToDate((d) => addDays(d, days));
  }

  function resetToToday() {
    const start = todayIso();
    setFromDate(start);
    setToDate(addDays(start, DEFAULT_WINDOW_DAYS - 1));
  }

  function openNoteModal(date: ISODate) {
    setNoteModalDate(date);
    setNoteDraft(notesByDate.get(date)?.notes ?? "");
  }

  async function saveNote() {
    if (!noteModalDate) return;
    setSaving(true);
    const res = await fetch("/api/daily-meal-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: noteModalDate, notes: noteDraft }),
    });
    setSaving(false);
    if (!res.ok) return;
    setNoteModalDate(null);
    await loadNotes();
  }

  return (
    <div className="tr-shell">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <h1 className="tr-page-title" style={{ margin: 0 }}>
          Kitchen Prep Matrix
          <span className="tr-print-only" style={{ fontWeight: 400, fontSize: 14, marginLeft: 8 }}>
            — {formatDateUk(fromDate)} to {formatDateUk(toDate)}
          </span>
        </h1>
        <span style={{ flex: 1 }} />
        <span className="tr-no-print" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <DateField value={fromDate} onChange={(iso) => iso && setFromDate(iso)} />
          <span className="tr-muted">to</span>
          <DateField value={toDate} onChange={(iso) => iso && setToDate(iso)} />
        </span>
        <button type="button" className="tr-no-print" onClick={() => shiftRange(-dates.length)}>← Prev</button>
        <button type="button" className="tr-no-print" onClick={resetToToday}>Today</button>
        <button type="button" className="tr-no-print" onClick={() => shiftRange(dates.length)}>Next →</button>
        <button type="button" className="tr-no-print primary" onClick={() => window.print()}>Print / Export</button>
      </div>

      <div className="tr-card" style={{ overflowX: "auto" }}>
        <table className="tr-table">
          <thead>
            <tr>
              <th style={{ minWidth: 90 }}>Meal</th>
              {dates.map((date) => {
                const note = notesByDate.get(date);
                return (
                  <th key={date} style={{ minWidth: 150 }}>
                    <div>{weekday(date)} {formatDateUk(date).slice(0, 5)}</div>
                    <button
                      type="button"
                      className="tr-no-print"
                      onClick={() => openNoteModal(date)}
                      style={{
                        marginTop: 4,
                        fontWeight: 400,
                        fontSize: 11,
                        minHeight: "unset",
                        padding: "2px 8px",
                        background: note?.notes ? "var(--tr-accent-soft)" : undefined,
                      }}
                    >
                      {note?.notes ? "Notes ●" : "+ Notes"}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {MEALS.map((meal) => (
              <tr key={meal.key}>
                <td style={{ fontWeight: 600 }}>{meal.label}</td>
                {dates.map((date) => {
                  const guests = guestsForMeal(bookings, date, meal.key);
                  const tags = aggregateDietaryTags(guests);
                  return (
                    <td key={date} style={{ verticalAlign: "top" }}>
                      <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>{guests.length}</div>
                      {tags.length > 0 && (
                        <ul className="tr-muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 0, paddingLeft: 16 }}>
                          {tags.map((t) => (
                            <li key={t.tag}>{t.count}x {t.tag}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td className="tr-muted" style={{ fontSize: 11 }}>Notes</td>
              {dates.map((date) => (
                <td key={date} className="tr-muted tr-cell-clip" style={{ fontSize: 11 }} title={notesByDate.get(date)?.notes ?? ""}>
                  {notesByDate.get(date)?.notes ?? "—"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {noteModalDate && (
        <div
          className="tr-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setNoteModalDate(null);
          }}
        >
          <div className="tr-modal">
            <h2 style={{ marginTop: 0, fontSize: 16 }}>
              Notes — {weekday(noteModalDate)} {formatDateUk(noteModalDate)}
            </h2>
            <textarea
              autoFocus
              rows={4}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="e.g. extra 2 covers for a walk-in guest"
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={() => setNoteModalDate(null)} disabled={saving}>Cancel</button>
              <button type="button" className="primary" onClick={saveNote} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
