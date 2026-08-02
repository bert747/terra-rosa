"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDateUk } from "@/lib/dates";
import { addDays, type ISODate } from "@/lib/occupancy";
import { guestsForMeal, aggregateDietaryTags, type MealBooking, type MealType } from "@/lib/kitchen";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WINDOW_DAYS = 7;
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
  const [windowStart, setWindowStart] = useState<ISODate>(todayIso);
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

  const dates = useMemo(
    () => Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(windowStart, i)),
    [windowStart]
  );

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
        <h1 className="tr-page-title" style={{ margin: 0 }}>Kitchen Prep Matrix</h1>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setWindowStart(addDays(windowStart, -WINDOW_DAYS))}>← Prev week</button>
        <button type="button" onClick={() => setWindowStart(todayIso())}>Today</button>
        <button type="button" onClick={() => setWindowStart(addDays(windowStart, WINDOW_DAYS))}>Next week →</button>
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
