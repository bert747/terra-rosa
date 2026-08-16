"use client";

import { useEffect, useState } from "react";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import DietaryTagInput from "@/components/DietaryTagInput";
import { useDietaryTagSuggestions } from "@/lib/use-dietary-tag-suggestions";

interface GuestRow {
  id: number;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  dietariesTags: string[] | null;
  email: string | null;
  phone: string | null;
}

function guestName(g: GuestRow): string {
  const name = `${g.firstName} ${g.lastName}`.trim();
  return g.preferredName ? `${name} (${g.preferredName})` : name;
}

function defaultForm() {
  return { firstName: "", lastName: "", preferredName: "", email: "", phone: "" };
}

export default function GuestsPage() {
  const [guests, setGuests] = useState<GuestRow[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);
  const dietarySuggestions = useDietaryTagSuggestions();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [rowEditMode, setRowEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmModalState | null>(null);

  async function load(q: string) {
    const url = q.trim() ? `/api/guests?q=${encodeURIComponent(q.trim())}` : "/api/guests";
    const rows = (await fetch(url).then((r) => r.json())) as GuestRow[];
    setGuests(rows);
  }

  // Debounced against the same search endpoint the booking form's own
  // autocomplete uses — see GuestProfilePicker for why this API returns
  // everything when `q` is blank (this page's own default listing) versus
  // a capped substring match otherwise.
  useEffect(() => {
    const timer = setTimeout(() => load(search), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function beginEdit(g: GuestRow) {
    setEditingId(g.id);
    setForm({
      firstName: g.firstName,
      lastName: g.lastName,
      preferredName: g.preferredName ?? "",
      email: g.email ?? "",
      phone: g.phone ?? "",
    });
    setDietaryTags(Array.isArray(g.dietariesTags) ? g.dietariesTags : []);
  }

  function closeModal() {
    setEditingId(null);
    setForm(defaultForm());
    setDietaryTags([]);
  }

  async function saveGuest(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setError(null);
    setSaving(true);
    const res = await fetch(`/api/guests/${editingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        preferredName: form.preferredName.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        dietariesTags: dietaryTags.length > 0 ? dietaryTags : null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not update guest profile.");
      return;
    }
    closeModal();
    load(search);
  }

  function deleteGuest(g: GuestRow) {
    setConfirmState({
      title: "Delete guest profile?",
      message: `Delete the profile for "${guestName(g)}"? Bookings currently linked to it keep their own name/dietary info as last saved, but stop being linked to any profile. This can't be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        setError(null);
        const res = await fetch(`/api/guests/${g.id}`, { method: "DELETE" });
        if (!res.ok) {
          setError((await res.json()).error ?? "Could not delete guest profile.");
          return;
        }
        if (editingId === g.id) closeModal();
        load(search);
      },
    });
  }

  return (
    <div className="tr-shell">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Guest profiles ({guests.length})</h1>
        <span style={{ flex: 1 }} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search first name, surname or preferred name…"
          style={{ minWidth: 240 }}
        />
        <button type="button" className={rowEditMode ? "primary" : undefined} onClick={() => setRowEditMode((v) => !v)}>
          {rowEditMode ? "Done" : "Edit"}
        </button>
      </div>

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <p className="tr-muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 12 }}>
        Profiles are created from the booking form, not here — this page is for finding an existing one to fix a
        mistake or update contact details.
      </p>

      <div className="tr-card">
        <div className="tr-table-wrap">
          <table className="tr-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Dietary</th>
                <th>Email</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
              {guests.length === 0 && (
                <tr>
                  <td colSpan={4} className="tr-muted">
                    {search.trim() ? "No matching guest profiles." : "No guest profiles yet."}
                  </td>
                </tr>
              )}
              {guests.map((g) => (
                <tr
                  key={g.id}
                  onClick={rowEditMode ? () => beginEdit(g) : undefined}
                  style={{ cursor: rowEditMode ? "pointer" : undefined }}
                  className={rowEditMode ? "tr-row-clickable" : undefined}
                >
                  <td style={{ fontWeight: 600 }}>{guestName(g)}</td>
                  <td className="tr-muted">{Array.isArray(g.dietariesTags) && g.dietariesTags.length > 0 ? g.dietariesTags.join(", ") : "—"}</td>
                  <td className="tr-muted">{g.email ?? "—"}</td>
                  <td className="tr-muted">{g.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editingId != null && (
        <div
          className="tr-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <form className="tr-modal" onSubmit={saveGuest}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Edit guest profile</h2>

            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <label style={{ display: "block", flex: 1 }}>
                <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>First name</div>
                <input
                  autoFocus
                  required
                  style={{ width: "100%" }}
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                />
              </label>
              <label style={{ display: "block", flex: 1 }}>
                <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Last name</div>
                <input
                  required
                  style={{ width: "100%" }}
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                />
              </label>
            </div>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Preferred name</div>
              <input
                style={{ width: "100%" }}
                value={form.preferredName}
                onChange={(e) => setForm({ ...form, preferredName: e.target.value })}
                placeholder="Optional"
              />
            </label>
            <label style={{ display: "block", marginBottom: 12 }}>
              <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Dietary tags</div>
              <DietaryTagInput tags={dietaryTags} onChange={setDietaryTags} suggestions={dietarySuggestions} placeholder="e.g. Gluten-Free" />
            </label>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <label style={{ display: "block", flex: 1 }}>
                <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Email</div>
                <input
                  type="email"
                  style={{ width: "100%" }}
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="Optional"
                />
              </label>
              <label style={{ display: "block", flex: 1 }}>
                <div className="tr-muted" style={{ fontSize: 12, marginBottom: 4 }}>Phone</div>
                <input
                  type="tel"
                  style={{ width: "100%" }}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="Optional"
                />
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button
                type="button"
                className="tr-danger"
                onClick={() => {
                  const g = guests.find((row) => row.id === editingId);
                  if (g) deleteGuest(g);
                }}
              >
                Delete
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={closeModal} disabled={saving}>Cancel</button>
                <button type="submit" className="primary" disabled={saving}>
                  {saving ? "Saving…" : "Save"}
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
