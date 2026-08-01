"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { nightsBetween } from "@/lib/dates";
import DietaryTagInput from "@/components/DietaryTagInput";
import { STANDARD_DIETARY_TAGS } from "@/lib/dietary-tags";

interface BedOption {
  id: number;
  type: string;
  room: { roomId: number; roomName: string; floorId: number; floorName: string } | null;
}

interface Booking {
  id: number;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  groupId: string | null;
  bedId: number | null;
  dietariesTags: string[] | null;
}

export default function BookingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [booking, setBooking] = useState<Booking | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [draft, setDraft] = useState<{
    guestName: string;
    arrivalDate: string;
    departureDate: string;
    groupId: string;
    bedId: string;
  } | null>(null);
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [b, beds] = await Promise.all([
      fetch(`/api/bookings/${id}`).then((res) => res.json()),
      fetch("/api/beds").then((res) => res.json()),
    ]);
    setBooking(b);
    setBedOptions(beds);
    setDraft({
      guestName: b.guestName,
      arrivalDate: b.arrivalDate,
      departureDate: b.departureDate,
      groupId: b.groupId ?? "",
      bedId: b.bedId ? String(b.bedId) : "",
    });
    setDietaryTags(Array.isArray(b.dietariesTags) ? b.dietariesTags : []);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const hasUnsavedChanges = useMemo(() => {
    if (!booking || !draft) return false;
    return (
      booking.guestName !== draft.guestName ||
      booking.arrivalDate !== draft.arrivalDate ||
      booking.departureDate !== draft.departureDate ||
      (booking.groupId ?? "") !== draft.groupId ||
      (booking.bedId ? String(booking.bedId) : "") !== draft.bedId ||
      JSON.stringify(booking.dietariesTags ?? []) !== JSON.stringify(dietaryTags)
    );
  }, [booking, draft, dietaryTags]);

  async function saveChanges(): Promise<boolean> {
    if (!draft) return true;
    setSaving(true);
    setError(null);

    if (!draft.guestName.trim()) {
      setSaving(false);
      setError("Guest name is required.");
      return false;
    }
    if (!draft.arrivalDate || !draft.departureDate || draft.departureDate <= draft.arrivalDate) {
      setSaving(false);
      setError("Valid arrival/departure dates are required.");
      return false;
    }

    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guestName: draft.guestName.trim(),
        arrivalDate: draft.arrivalDate,
        departureDate: draft.departureDate,
        groupId: draft.groupId.trim() || null,
        bedId: draft.bedId || null,
        dietariesTags: dietaryTags.length > 0 ? dietaryTags : null,
      }),
    });

    if (!res.ok) {
      setSaving(false);
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save booking changes.");
      return false;
    }

    setSaving(false);
    await load();
    return true;
  }

  async function saveAndExit() {
    const ok = await saveChanges();
    if (ok) router.push("/bookings");
  }

  async function deleteBooking() {
    if (!confirm("Delete this booking? This cannot be undone.")) return;
    await fetch(`/api/bookings/${id}`, { method: "DELETE" });
    router.push("/bookings");
  }

  if (!booking || !draft) {
    return (
      <div className="tr-shell">
        <p>Loading...</p>
      </div>
    );
  }

  const nights = nightsBetween(draft.arrivalDate, draft.departureDate);

  return (
    <div className="tr-shell" style={{ maxWidth: 720 }}>
      <div className="tr-page-header">
        <h1 className="tr-page-title" style={{ margin: 0 }}>{booking.guestName}</h1>
        <a href="/bookings" className="tr-back-link">← Back to Bookings</a>
      </div>

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card">
        <Field label="Guest name">
          <input value={draft.guestName} onChange={(e) => setDraft({ ...draft, guestName: e.target.value })} />
        </Field>

        <div className="tr-inline-grid">
          <Field label="Arrival date">
            <input type="date" value={draft.arrivalDate} onChange={(e) => setDraft({ ...draft, arrivalDate: e.target.value })} />
          </Field>
          <Field label="Departure date">
            <input type="date" value={draft.departureDate} onChange={(e) => setDraft({ ...draft, departureDate: e.target.value })} />
          </Field>
        </div>

        <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
          {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : ""}
        </p>

        <Field label="Bed">
          <select value={draft.bedId} onChange={(e) => setDraft({ ...draft, bedId: e.target.value })}>
            <option value="">— unassigned —</option>
            {bedOptions.map((bed) => (
              <option key={bed.id} value={bed.id}>
                {bed.type}{bed.room ? ` — ${bed.room.roomName} (${bed.room.floorName})` : " (unplaced)"}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Group ID">
          <input value={draft.groupId} onChange={(e) => setDraft({ ...draft, groupId: e.target.value })} />
        </Field>

        <Field label="Dietary tags">
          <DietaryTagInput tags={dietaryTags} onChange={setDietaryTags} suggestions={STANDARD_DIETARY_TAGS} placeholder="e.g. Gluten-Free" />
        </Field>
      </div>

      <div className="tr-card">
        <h2 className="tr-section-title" style={{ marginBottom: 8 }}>Delete booking</h2>
        <button type="button" className="tr-danger" onClick={deleteBooking}>Delete Booking</button>
      </div>

      <div className="tr-sticky-actions">
        <button type="button" onClick={() => router.push("/bookings")}>Back</button>
        <button type="button" className="primary" onClick={saveChanges} disabled={!hasUnsavedChanges || saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="primary" onClick={saveAndExit} disabled={saving}>
          Save and Exit
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tr-field">
      <label className="tr-label">{label}</label>
      {children}
    </div>
  );
}
