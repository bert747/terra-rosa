"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatDateUk } from "@/lib/dates";
import { addDays } from "@/lib/occupancy";
import DateField from "@/components/DateField";
import HelpButton from "@/components/HelpButton";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import ColourPicker from "@/components/ColourPicker";
import { COLOUR_PRESETS } from "@/lib/colour-presets";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultForm() {
  const start = todayIso();
  return { name: "", startDate: start, endDate: addDays(start, 7), notes: "", colour: COLOUR_PRESETS[0] };
}

interface EventRow {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  notes: string | null;
  colour: string | null;
}

export default function EventsPage() {
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  // Whether the modal is open at all — separate from editingId (null while
  // adding, an id while editing) so "closed" is one flag rather than two
  // states (editingId === null AND modalOpen === false) that could drift
  // out of sync.
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // A single "Edit" toggle above the table (rather than per-row Edit/
  // Delete buttons cluttering every row) — turning it on makes rows
  // clickable to open them in the same modal used for "New Event"; off,
  // rows are just plain read-only text. Mirrors the same toggle-reveals-
  // row-actions pattern the Layout settings page uses for Floors & Rooms.
  const [rowEditMode, setRowEditMode] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmModalState | null>(null);

  async function load() {
    const rows = (await fetch("/api/events").then((r) => r.json())) as EventRow[];
    setEvents(rows);

    const editIdRaw = searchParams.get("edit");
    if (!editIdRaw) return;
    const editId = Number(editIdRaw);
    if (!Number.isInteger(editId) || editId < 1) return;

    const target = rows.find((row) => row.id === editId);
    if (!target) return;
    beginEdit(target);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function saveEvent(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const method = editingId ? "PATCH" : "POST";
    const path = editingId ? `/api/events/${editingId}` : "/api/events";
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json()).error ?? `Could not ${editingId ? "update" : "add"} event.`);
      return;
    }
    closeModal();
    load();
  }

  function deleteEvent(eventId: number) {
    setConfirmState({
      title: "Delete event?",
      message: "This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        setError(null);
        const res = await fetch(`/api/events/${eventId}`, { method: "DELETE" });
        if (!res.ok) {
          setError((await res.json()).error ?? "Could not delete event.");
          return;
        }
        if (editingId === eventId) closeModal();
        load();
      },
    });
  }

  function beginAdd() {
    setEditingId(null);
    setForm(defaultForm());
    setModalOpen(true);
  }

  function beginEdit(ev: EventRow) {
    setEditingId(ev.id);
    setForm({
      name: ev.name,
      startDate: ev.startDate,
      endDate: ev.endDate,
      notes: ev.notes ?? "",
      // An event created before colour existed just starts the picker on
      // the first preset — picking Save (even without touching the
      // picker) then gives it a real colour, same as any other field here.
      colour: ev.colour ?? COLOUR_PRESETS[0],
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(defaultForm());
  }

  return (
    <div className="tr-shell">
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>Events / retreat periods</h1>
      <HelpButton title="Using Events">
        Anything added here shows as a band across the top of the <a href="/grid">grid</a> for the days it covers.
        The end date is <strong>inclusive</strong> — an event from the 1st to the 7th covers seven days, the last of
        them the 7th.
      </HelpButton>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className={rowEditMode ? "primary" : undefined}
            onClick={() => setRowEditMode((v) => !v)}
          >
            {rowEditMode ? "Done" : "Edit"}
          </button>
          <button type="button" className="primary" onClick={beginAdd}>
            + New Event
          </button>
        </div>
        <div className="tr-table-wrap">
          <table className="tr-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Start</th>
              <th>End</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr
                key={ev.id}
                onClick={rowEditMode ? () => beginEdit(ev) : undefined}
                style={{
                  cursor: rowEditMode ? "pointer" : undefined,
                  // Same stripe + pale-tint pattern as BookingsTable's own
                  // guest-category row — see that component's identical
                  // comment for why the stripe goes through a CSS variable
                  // rather than a raw inline box-shadow.
                  ...(ev.colour
                    ? ({
                        ["--tr-row-stripe" as string]: ev.colour,
                        backgroundColor: `color-mix(in srgb, ${ev.colour} 24%, white)`,
                      } as React.CSSProperties)
                    : {}),
                }}
                className={rowEditMode ? "tr-row-clickable" : "tr-row-tinted"}
              >
                <td>{ev.name}</td>
                <td>{formatDateUk(ev.startDate)}</td>
                <td>{formatDateUk(ev.endDate)}</td>
                <td className="tr-muted tr-cell-clip" data-tooltip={ev.notes ?? ""}>{ev.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div
          className="tr-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <form className="tr-modal" onSubmit={saveEvent}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>{editingId ? "Edit event" : "New event"}</h2>

            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Name</div>
              <input
                autoFocus
                required
                style={{ width: "100%" }}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Start</div>
              <DateField required value={form.startDate} onChange={(iso) => setForm({ ...form, startDate: iso })} />
            </label>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>End</div>
              <DateField required value={form.endDate} onChange={(iso) => setForm({ ...form, endDate: iso })} />
            </label>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Notes</div>
              <input
                style={{ width: "100%" }}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>
            <label style={{ display: "block", marginBottom: 16 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Colour</div>
              <ColourPicker value={form.colour} onChange={(hex) => setForm({ ...form, colour: hex })} />
            </label>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              {editingId ? (
                <button type="button" className="tr-danger" onClick={() => deleteEvent(editingId)}>
                  Delete
                </button>
              ) : <span />}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={closeModal} disabled={saving}>Cancel</button>
                <button type="submit" className="primary" disabled={saving}>
                  {editingId ? "Save" : "Add event"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />
    </div>
  );
}
