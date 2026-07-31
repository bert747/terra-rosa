"use client";

import { useEffect, useState } from "react";
import { normaliseDietaryTag, splitDietaryTags } from "@/lib/dietary-tags";

interface MealCounts {
  date: string;
  breakfast: number;
  lunch: number;
  dinner: number;
}
interface MealNote {
  date: string;
  notes: string | null;
}
interface DietaryEntry {
  bookingId: number;
  dietaryRequirements: string;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DAYS_VISIBLE = 7;

function allergenSummary(entries: DietaryEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const raw of splitDietaryTags(entry.dietaryRequirements)) {
      const tag = normaliseDietaryTag(raw);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tag, count]) => `${count}x ${tag}`);
}

export default function MealsPage() {
  const [start, setStart] = useState(todayISO());
  const [counts, setCounts] = useState<Record<string, MealCounts>>({});
  const [notesByDate, setNotesByDate] = useState<Record<string, MealNote>>({});
  const [editing, setEditing] = useState<{ date: string; notes: string } | null>(null);
  const [dietary, setDietary] = useState<Record<string, DietaryEntry[]>>({});

  const dates = Array.from({ length: DAYS_VISIBLE }, (_, i) => addDays(start, i));

  async function load() {
    const [countsRes, noteResults, dietaryRes] = await Promise.all([
      fetch(`/api/meal-counts?dates=${dates.join(",")}`).then((r) => r.json()),
      Promise.all(
        dates.map(async (d) => {
          const res = await fetch(`/api/meal-notes?date=${d}`);
          const note = await res.json();
          return { date: d, note };
        })
      ),
      fetch(`/api/dietary?dates=${dates.join(",")}`).then((r) => r.json()),
    ]);

    setDietary(dietaryRes);

    const countsMap: Record<string, MealCounts> = {};
    for (const c of countsRes as MealCounts[]) countsMap[c.date] = c;
    setCounts(countsMap);

    const map: Record<string, MealNote> = {};
    for (const r of noteResults) {
      if (r.note) map[r.date] = r.note;
    }
    setNotesByDate(map);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  async function saveNote(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    await fetch("/api/meal-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });
    setEditing(null);
    load();
  }

  return (
    <div className="tr-shell">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Meal planning</h1>
        <span style={{ flex: 1 }} />
        <button onClick={() => setStart(addDays(start, -DAYS_VISIBLE))}>Previous week</button>
        <button onClick={() => setStart(todayISO())}>This week</button>
        <button onClick={() => setStart(addDays(start, DAYS_VISIBLE))}>Next week</button>
      </div>

      <p className="tr-muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Breakfast(D) = in-house the night before. Lunch(D) = that minus today&apos;s departures.
        Dinner(D) = that minus departures plus today&apos;s arrivals.
      </p>

      <div className="tr-card">
        <div className="tr-table-wrap">
          <table className="tr-table">
          <thead>
            <tr>
              <th>Metric</th>
              {dates.map((d) => (
                <th key={d}>
                  <div>{d}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Breakfast</strong></td>
              {dates.map((d) => <td key={`b-${d}`}>{counts[d]?.breakfast ?? "—"}</td>)}
            </tr>
            <tr>
              <td><strong>Lunch</strong></td>
              {dates.map((d) => <td key={`l-${d}`}>{counts[d]?.lunch ?? "—"}</td>)}
            </tr>
            <tr>
              <td><strong>Dinner</strong></td>
              {dates.map((d) => <td key={`d-${d}`}>{counts[d]?.dinner ?? "—"}</td>)}
            </tr>
            <tr>
              <td><strong>Allergens / dietary</strong></td>
              {dates.map((d) => {
                const tags = allergenSummary(dietary[d] ?? []);
                return (
                  <td key={`a-${d}`}>
                    {tags.length === 0 ? (
                      <span className="tr-muted">—</span>
                    ) : (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {tags.map((tag) => (
                          <span key={`${d}-${tag}`} className="tr-badge tr-badge-ok">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
            <tr>
              <td><strong>Notes</strong></td>
              {dates.map((d) => {
                const note = notesByDate[d];
                return (
                  <td key={`n-${d}`}>
                    <div className="tr-muted" style={{ marginBottom: 6 }}>{note?.notes?.trim() || "—"}</div>
                    <button
                      onClick={() =>
                        setEditing({
                          date: d,
                          notes: note?.notes ?? "",
                        })
                      }
                    >
                      Edit
                    </button>
                  </td>
                );
              })}
            </tr>
          </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="tr-move-modal-backdrop">
          <div className="tr-move-modal" style={{ maxWidth: 420 }}>
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>Edit {editing.date}</h3>
            <form onSubmit={saveNote} style={{ display: "grid", gap: 8 }}>
              <div>
                <label style={{ display: "block", fontSize: 12 }}>Notes</label>
                <textarea rows={3} style={{ width: "100%" }} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" className="primary">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
