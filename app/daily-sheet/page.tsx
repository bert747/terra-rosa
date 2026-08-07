"use client";

import { useEffect, useMemo, useState } from "react";
import { addDays, type ISODate } from "@/lib/occupancy";
import { formatDateUk, mondayOf } from "@/lib/dates";
import { guestsForMeal, aggregateDietaryTags, type MealBooking, type MealType } from "@/lib/kitchen";
import { CalendarIcon, CalendarPopover } from "@/components/DateField";
import HelpButton from "@/components/HelpButton";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MEALS: { key: MealType; label: string }[] = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
];

function todayIso(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

const DATE_STORAGE_KEY = "tr-daily-sheet-date";

/** Whatever date was last viewed here, so navigating away (to the grid, say) and back doesn't reset to today. */
function initialDate(): ISODate {
  if (typeof window === "undefined") return todayIso();
  return window.sessionStorage.getItem(DATE_STORAGE_KEY) || todayIso();
}

function weekday(date: ISODate): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

interface BedTypeCount {
  bedType: string;
  made: number;
  total: number;
}

interface RoomBedCount {
  roomName: string;
  byType: BedTypeCount[];
}

interface ArrivalEntry {
  guestName: string;
  roomName: string;
}

interface DepartureEntry {
  guestName: string;
}

interface OngoingEvent {
  name: string;
  dayOfEvent: number;
  totalDays: number;
}

interface HousekeepingSheet {
  moverTasks: string[];
  arrivals: ArrivalEntry[];
  departures: DepartureEntry[];
  eventsOngoing: OngoingEvent[];
  roomsToMake: RoomBedCount[];
}

const EMPTY_SHEET: HousekeepingSheet = {
  moverTasks: [],
  arrivals: [],
  departures: [],
  eventsOngoing: [],
  roomsToMake: [],
};

interface DailyNote {
  id: number;
  date: ISODate;
  notes: string | null;
}

/** Filled dots for beds that need making, outline dots for the room's remaining beds of that type — "2 of 3" at a glance, printable. */
function BedDots({ made, total }: { made: number; total: number }) {
  const dots = Array.from({ length: Math.max(made, total) }, (_, i) => i < made);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span aria-hidden="true" style={{ letterSpacing: 2 }}>
        {dots.map((filled, i) => (
          <span key={i} style={{ color: filled ? "var(--tr-accent)" : "var(--tr-border-strong)" }}>
            {filled ? "●" : "○"}
          </span>
        ))}
      </span>
      <span className="tr-muted" style={{ fontSize: 12 }}>
        {made} of {total}
      </span>
    </span>
  );
}

/** A sub-section within a shared card — a thin inset rule above it (except the first) stands in for a separate box. */
function Section({ first, children }: { first?: boolean; children: React.ReactNode }) {
  return (
    <div style={first ? undefined : { marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--tr-border)" }}>
      {children}
    </div>
  );
}

/**
 * One row of nav controls shared by both the Meals and Housekeeping
 * sections: prev/next (whatever step the caller means — a week or a day),
 * a calendar-icon button that reveals a real month-grid picker (the same
 * one DateField uses, not a bare text field) only while picking, and Today.
 */
function DateNavRow({
  date,
  onPick,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
}: {
  date: ISODate;
  onPick: (date: ISODate) => void;
  onPrev: () => void;
  onNext: () => void;
  prevLabel: string;
  nextLabel: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="tr-no-print" style={{ display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
      <button type="button" onClick={onPrev}>{prevLabel}</button>
      <button
        type="button"
        aria-label="Open calendar"
        onClick={() => setPickerOpen((v) => !v)}
        // Matches DateField.tsx's own calendar button height exactly (42px,
        // the adjacent date input's real rendered height) — see that
        // component's own comment for why this can't just be padding-based.
        style={{ height: 42, padding: "0 10px", lineHeight: 1, display: "inline-flex", alignItems: "center" }}
      >
        <CalendarIcon />
      </button>
      {pickerOpen && (
        <div style={{ position: "absolute", top: "100%", left: 32, zIndex: 10 }}>
          <CalendarPopover
            value={date}
            onPick={(iso) => {
              onPick(iso);
              setPickerOpen(false);
            }}
          />
        </div>
      )}
      <button type="button" onClick={() => onPick(todayIso())}>Today</button>
      <button type="button" onClick={onNext}>{nextLabel}</button>
    </div>
  );
}

/**
 * One shared "Print / Export" control, used above BOTH the Meals and
 * Housekeeping sections — picking a scope sets a data attribute on <body>
 * that the print stylesheet (see .tr-meals-section/.tr-housekeeping-section
 * in globals.css) uses to hide whichever section wasn't asked for, then
 * triggers the browser's own print dialog. The attribute is cleared again
 * on "afterprint" (fires whether the user actually printed or cancelled)
 * so a later plain reprint/Ctrl+P isn't left silently scoped to whatever
 * was picked last.
 */
function PrintExportButton() {
  const [menuOpen, setMenuOpen] = useState(false);

  function printScoped(scope: "meals" | "housekeeping" | "both") {
    setMenuOpen(false);
    document.body.dataset.printScope = scope;
    function reset() {
      delete document.body.dataset.printScope;
      window.removeEventListener("afterprint", reset);
      // Chromium quirk: printing a table with table-layout:auto (see
      // .tr-table) recomputes its column widths for the print pass, and
      // doesn't always reflow them back down on return to screen — leaving
      // a stray horizontal scrollbar under the meal table. A synchronous
      // reflow of the whole page clears the stale layout.
      document.body.style.display = "none";
      void document.body.offsetHeight;
      document.body.style.display = "";
    }
    window.addEventListener("afterprint", reset);
    window.print();
  }

  return (
    <div className="tr-no-print" style={{ position: "relative" }}>
      <button type="button" className="primary" onClick={() => setMenuOpen((v) => !v)}>
        Print / Export
      </button>
      {menuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setMenuOpen(false)} />
          <div className="tr-actions-menu" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30, width: 200, padding: 6 }}>
            <button type="button" className="tr-columns-menu-item" style={{ width: "100%" }} onClick={() => printScoped("meals")}>
              Meals only
            </button>
            <button type="button" className="tr-columns-menu-item" style={{ width: "100%" }} onClick={() => printScoped("housekeeping")}>
              Housekeeping only
            </button>
            <button type="button" className="tr-columns-menu-item" style={{ width: "100%" }} onClick={() => printScoped("both")}>
              Both
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function DailySheetPage() {
  const [date, setDate] = useState<ISODate>(initialDate);
  const [sheet, setSheet] = useState<HousekeepingSheet>(EMPTY_SHEET);
  const [loadingSheet, setLoadingSheet] = useState(false);

  useEffect(() => {
    window.sessionStorage.setItem(DATE_STORAGE_KEY, date);
  }, [date]);

  const [mealBookings, setMealBookings] = useState<MealBooking[]>([]);
  const [notesByDate, setNotesByDate] = useState<Map<ISODate, DailyNote>>(new Map());
  const [noteModalDate, setNoteModalDate] = useState<ISODate | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    setLoadingSheet(true);
    fetch(`/api/housekeeping?date=${date}`)
      .then((r) => r.json())
      .then((body) => setSheet({ ...EMPTY_SHEET, ...body }))
      .finally(() => setLoadingSheet(false));
  }, [date]);

  async function loadMealBookings() {
    const rows = (await fetch("/api/bookings").then((r) => r.json())) as MealBooking[];
    setMealBookings(rows);
  }
  async function loadNotes() {
    const rows = (await fetch("/api/daily-meal-notes").then((r) => r.json())) as DailyNote[];
    setNotesByDate(new Map(rows.map((r) => [r.date, r])));
  }
  useEffect(() => {
    loadMealBookings();
    loadNotes();
  }, []);

  // Always a Monday-start 7-day span — the kitchen never wants a table
  // beginning on a random weekday, no matter what day is picked below for
  // housekeeping. Changing `date` only ever re-derives which week this is;
  // it doesn't shift the anchor within the week.
  const weekDates = useMemo(() => {
    const monday = mondayOf(date);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [date]);

  function openNoteModal(noteDate: ISODate) {
    setNoteModalDate(noteDate);
    setNoteDraft(notesByDate.get(noteDate)?.notes ?? "");
  }
  async function saveNote(notes: string) {
    if (!noteModalDate) return;
    setSavingNote(true);
    const res = await fetch("/api/daily-meal-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: noteModalDate, notes }),
    });
    setSavingNote(false);
    if (!res.ok) return;
    setNoteModalDate(null);
    await loadNotes();
  }

  return (
    <div className="tr-shell">
      {/* No page-title <h1> here — the nav tab itself already says which
          page this is (see the Chrome-style tab redesign), so a plain
          "Daily Sheet" heading was just repeating that on its own line for
          no reason, pushing Print/Export and the week-nav controls apart
          onto two separate rows when they fit fine on one. */}
      <div className="tr-meals-section">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 className="tr-section-title" style={{ margin: 0 }}>
          Meals
          <span className="tr-muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
            {formatDateUk(weekDates[0])} to {formatDateUk(weekDates[6])}
          </span>
        </h2>
        <span style={{ flex: 1 }} />
        <DateNavRow
          date={date}
          onPick={setDate}
          onPrev={() => setDate(addDays(date, -7))}
          onNext={() => setDate(addDays(date, 7))}
          prevLabel="← Prev week"
          nextLabel="Next week →"
        />
        <PrintExportButton />
      </div>

      <div className="tr-card" style={{ marginBottom: 24, overflowX: "auto" }}>
        <table className="tr-table">
          <thead>
            <tr>
              <th style={{ minWidth: 90 }}>Meal</th>
              {weekDates.map((d) => (
                <th
                  key={d}
                  className="tr-no-print"
                  onClick={() => setDate(d)}
                  data-tooltip="Show this day in Housekeeping below"
                  style={{ minWidth: 150, cursor: "pointer", background: d === date ? "var(--tr-accent-soft)" : undefined }}
                >
                  {weekday(d)} {formatDateUk(d).slice(0, 5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MEALS.map((meal) => (
              <tr key={meal.key}>
                <td style={{ fontWeight: 600 }}>{meal.label}</td>
                {weekDates.map((d) => {
                  const guests = guestsForMeal(mealBookings, d, meal.key);
                  const tags = aggregateDietaryTags(guests);
                  return (
                    <td key={d} style={{ verticalAlign: "top", background: d === date ? "var(--tr-accent-soft)" : undefined }}>
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
              {weekDates.map((d) => {
                const note = notesByDate.get(d);
                return (
                  <td key={d} style={{ fontSize: 11, background: d === date ? "var(--tr-accent-soft)" : undefined }}>
                    <button
                      type="button"
                      className="tr-no-print tr-cell-clip"
                      onClick={() => openNoteModal(d)}
                      data-tooltip={note?.notes ?? ""}
                      style={{
                        display: "block",
                        maxWidth: "100%",
                        fontWeight: 400,
                        fontSize: 11,
                        minHeight: "unset",
                        padding: "2px 8px",
                        textAlign: "left",
                        background: note?.notes ? "var(--tr-accent-soft)" : undefined,
                      }}
                    >
                      {note?.notes || "+ Notes"}
                    </button>
                    <span className="tr-print-only tr-muted">{note?.notes ?? "—"}</span>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      </div>

      <div className="tr-housekeeping-section">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <h2 className="tr-section-title" style={{ margin: 0 }}>Housekeeping</h2>
        <span style={{ flex: 1 }} />
        <DateNavRow
          date={date}
          onPick={setDate}
          onPrev={() => setDate(addDays(date, -1))}
          onNext={() => setDate(addDays(date, 1))}
          prevLabel="← Prev day"
          nextLabel="Next day →"
        />
        <PrintExportButton />
      </div>

      {loadingSheet && <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>Loading…</p>}

      <HelpButton title="Using the Housekeeping section">
        Beds are made up on arrival day, or when a join/split changes a room&apos;s bed configuration. Moves that
        cancel each other out (two beds of the same type simply trading rooms) are netted to zero and won&apos;t
        show — nobody actually needs to carry anything for those.
      </HelpButton>

      <div className="tr-daily-sheet-columns" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="tr-card">
          <Section first>
            <h3 className="tr-section-title" style={{ marginBottom: 8 }}>Beds to move</h3>
            {sheet.moverTasks.length === 0 ? (
              <p className="tr-muted">No bed moves needed today.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {sheet.moverTasks.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
          </Section>

          <Section>
            <h3 className="tr-section-title" style={{ marginBottom: 8 }}>
              Beds to make
              <span className="tr-muted" style={{ fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
                ● needs making · ○ nothing to do
              </span>
            </h3>
            {sheet.roomsToMake.length === 0 ? (
              <p className="tr-muted">No beds to make today.</p>
            ) : (
              <div>
                {sheet.roomsToMake.map((r, i) => (
                  <div
                    key={r.roomName}
                    // Dashed, not solid — a lighter touch than the section
                    // divider above (see Section's own borderTop), so items
                    // WITHIN "Beds to Make" don't read at the same visual
                    // weight as the line separating it from "Beds to Move".
                    style={i > 0 ? { marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--tr-border)" } : undefined}
                  >
                    <strong>{r.roomName}</strong>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                      {r.byType.map((t) => (
                        <span key={t.bedType} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ minWidth: 60 }}>{t.bedType}</span>
                          <BedDots made={t.made} total={t.total} />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <div className="tr-card">
          <Section first>
            <h3 className="tr-section-title" style={{ marginBottom: 8 }}>Events</h3>
            {sheet.eventsOngoing.length === 0 ? (
              <p className="tr-muted">No events today.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {sheet.eventsOngoing.map((e, i) => (
                  <li key={i}>{e.name} (Day {e.dayOfEvent} of {e.totalDays})</li>
                ))}
              </ul>
            )}
          </Section>

          <Section>
            <h3 className="tr-section-title" style={{ marginBottom: 8 }}>Arrivals</h3>
            {sheet.arrivals.length === 0 ? (
              <p className="tr-muted">No arrivals today.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {sheet.arrivals.map((a, i) => (
                  <li key={i}>{a.guestName} ({a.roomName})</li>
                ))}
              </ul>
            )}
          </Section>

          <Section>
            <h3 className="tr-section-title" style={{ marginBottom: 8 }}>Departures</h3>
            {sheet.departures.length === 0 ? (
              <p className="tr-muted">No departures today.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {sheet.departures.map((d, i) => (
                  <li key={i}>{d.guestName}</li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
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
              {(notesByDate.get(noteModalDate)?.notes ?? "") !== "" && (
                <button type="button" className="tr-danger" onClick={() => saveNote("")} disabled={savingNote} style={{ marginRight: "auto" }}>
                  Delete
                </button>
              )}
              <button type="button" onClick={() => setNoteModalDate(null)} disabled={savingNote}>Cancel</button>
              <button type="button" className="primary" onClick={() => saveNote(noteDraft)} disabled={savingNote}>
                {savingNote ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
