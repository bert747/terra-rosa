"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isIsoDate, nightsBetween } from "@/lib/dates";
import DietaryTagInput from "@/components/DietaryTagInput";
import { STANDARD_DIETARY_TAGS } from "@/lib/dietary-tags";

interface BedOption {
  id: number;
  type: string;
  room: { roomId: number; roomName: string; floorId: number; floorName: string } | null;
}

export default function NewBookingPage() {
  return (
    <Suspense fallback={<div className="tr-shell">Loading...</div>}>
      <NewBookingForm />
    </Suspense>
  );
}

function dateParam(value: string | null): string {
  return value && isIsoDate(value) ? value : "";
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function NewBookingForm() {
  const router = useRouter();
  const search = useSearchParams();

  const prefillArrival = dateParam(search.get("arrival"));
  const prefillDeparture = dateParam(search.get("departure"));
  const prefillBedId = search.get("bedId") ?? "";

  const arrivalDefault = prefillArrival || new Date().toISOString().slice(0, 10);
  const departureDefault = prefillDeparture || addDaysIso(arrivalDefault, 1);

  const [error, setError] = useState<string | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    guestName: "",
    arrivalDate: arrivalDefault,
    departureDate: departureDefault,
    groupId: "",
    bedId: prefillBedId,
  });
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/beds")
      .then((r) => r.json())
      .then((data: BedOption[]) => setBedOptions(data))
      .catch(() => setBedOptions([]));
  }, []);

  const nights = nightsBetween(form.arrivalDate, form.departureDate);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (!form.guestName.trim()) {
      setSaving(false);
      setError("Guest name is required.");
      return;
    }
    if (!form.arrivalDate || !form.departureDate || form.departureDate <= form.arrivalDate) {
      setSaving(false);
      setError("Valid arrival/departure dates are required.");
      return;
    }

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guestName: form.guestName.trim(),
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        groupId: form.groupId.trim() || null,
        bedId: form.bedId || null,
        dietariesTags: dietaryTags.length > 0 ? dietaryTags : null,
      }),
    });

    if (!res.ok) {
      setSaving(false);
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not create booking.");
      return;
    }

    setSaving(false);
    router.push("/bookings");
  }

  return (
    <div className="tr-shell" style={{ maxWidth: 720 }}>
      <h1 className="tr-page-title">New Booking</h1>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <form onSubmit={handleSubmit} className="tr-card">
        <Field label="Guest name" required>
          <input
            required
            value={form.guestName}
            onChange={(e) => setForm({ ...form, guestName: e.target.value })}
            placeholder="Full name"
          />
        </Field>

        <div className="tr-inline-grid">
          <Field label="Arrival date" required>
            <input
              type="date"
              required
              value={form.arrivalDate}
              onChange={(e) => setForm({ ...form, arrivalDate: e.target.value })}
            />
          </Field>
          <Field label="Departure date" required>
            <input
              type="date"
              required
              value={form.departureDate}
              onChange={(e) => setForm({ ...form, departureDate: e.target.value })}
            />
          </Field>
        </div>

        <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
          {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : "Select both dates."}
        </p>

        <Field label="Bed">
          <select value={form.bedId} onChange={(e) => setForm({ ...form, bedId: e.target.value })}>
            <option value="">— unassigned —</option>
            {bedOptions.map((bed) => (
              <option key={bed.id} value={bed.id}>
                {bed.type}{bed.room ? ` — ${bed.room.roomName} (${bed.room.floorName})` : " (unplaced)"}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Group ID">
          <input
            value={form.groupId}
            onChange={(e) => setForm({ ...form, groupId: e.target.value })}
            placeholder="For linking bookings that arrived together"
          />
        </Field>

        <Field label="Dietary tags">
          <DietaryTagInput tags={dietaryTags} onChange={setDietaryTags} suggestions={STANDARD_DIETARY_TAGS} placeholder="e.g. Gluten-Free" />
        </Field>

        <div className="tr-form-actions">
          <button type="button" onClick={() => router.push("/bookings")}>Cancel</button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving..." : "Create Booking"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div className="tr-field">
      <label className="tr-label">
        {label}
        {required ? <span className="tr-required"> *</span> : null}
      </label>
      {children}
    </div>
  );
}
