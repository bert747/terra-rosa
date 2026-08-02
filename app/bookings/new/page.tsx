"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isIsoDate, nightsBetween } from "@/lib/dates";
import DietaryTagInput from "@/components/DietaryTagInput";
import DateField from "@/components/DateField";
import LinkedBookingSelect from "@/components/LinkedBookingSelect";
import ShareBedSelect from "@/components/ShareBedSelect";
import { STANDARD_DIETARY_TAGS } from "@/lib/dietary-tags";

interface BedOption {
  id: number;
  type: string;
  room: { roomId: number; roomName: string; floorId: number; floorName: string };
}

interface FallbackPair {
  bedId: number;
  partnerBedId: number;
  roomId: number;
  roomName: string;
}

const GUEST_TYPES: { value: string; label: string }[] = [
  { value: "guest", label: "Guest" },
  { value: "resident", label: "Resident" },
  { value: "ashrami", label: "Ashrami" },
];

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
  const [fallbackPairs, setFallbackPairs] = useState<FallbackPair[]>([]);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    guestName: "",
    arrivalDate: arrivalDefault,
    departureDate: departureDefault,
    linkedBookingId: null as number | null,
    sharesBedWithBookingId: null as number | null,
    bedTypeFilter: "single" as "single" | "double",
    bedId: prefillBedId,
    partnerBedId: "" as string,
    guestType: "guest",
  });
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);

  useEffect(() => {
    if (!isIsoDate(form.arrivalDate) || !isIsoDate(form.departureDate) || form.departureDate <= form.arrivalDate) {
      setBedOptions([]);
      setFallbackPairs([]);
      return;
    }
    const params = new URLSearchParams({ arrival: form.arrivalDate, departure: form.departureDate, bedType: form.bedTypeFilter });
    if (form.linkedBookingId != null) params.set("nearBookingId", String(form.linkedBookingId));
    fetch(`/api/beds/available?${params}`)
      .then((r) => r.json())
      .then((data: { rows: BedOption[]; fallbackPairs: FallbackPair[] }) => {
        setBedOptions(data.rows);
        setFallbackPairs(data.fallbackPairs ?? []);
        // The previously-picked bed can fall out of the list when the
        // dates/bed type change or a "sleeps near" pick narrows it down to
        // a different room — never leave a stale selection the dropdown no
        // longer offers.
        setForm((f) =>
          f.bedId && !data.rows.some((b) => String(b.id) === f.bedId) ? { ...f, bedId: "", partnerBedId: "" } : f
        );
      })
      .catch(() => {
        setBedOptions([]);
        setFallbackPairs([]);
      });
  }, [form.arrivalDate, form.departureDate, form.linkedBookingId, form.bedTypeFilter]);

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
        linkedBookingId: form.linkedBookingId,
        bedId: form.bedId || null,
        partnerBedId: form.partnerBedId || null,
        guestType: form.guestType,
        dietariesTags: dietaryTags.length > 0 ? dietaryTags : null,
      }),
    });

    if (!res.ok) {
      setSaving(false);
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not create booking.");
      return;
    }

    const booking = await res.json();

    if (form.sharesBedWithBookingId != null && form.bedId) {
      const shareRes = await fetch(`/api/bookings/${booking.id}/share-bed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerBookingId: form.sharesBedWithBookingId }),
      });
      if (!shareRes.ok) {
        setSaving(false);
        const body = await shareRes.json().catch(() => ({}));
        setError(`Booking created, but Shares Bed With failed: ${body.error ?? "unknown error"}`);
        return;
      }
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
            <DateField required value={form.arrivalDate} onChange={(iso) => setForm({ ...form, arrivalDate: iso })} />
          </Field>
          <Field label="Departure date" required>
            <DateField required value={form.departureDate} onChange={(iso) => setForm({ ...form, departureDate: iso })} />
          </Field>
        </div>

        <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
          {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : "Select both dates."}
        </p>

        <Field label="Guest type">
          <select value={form.guestType} onChange={(e) => setForm({ ...form, guestType: e.target.value })}>
            {GUEST_TYPES.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Sleeps near / Linked with">
          <LinkedBookingSelect
            value={form.linkedBookingId}
            onChange={(id) => setForm({ ...form, linkedBookingId: id })}
            arrivalDate={form.arrivalDate}
            departureDate={form.departureDate}
          />
        </Field>

        <div className="tr-inline-grid">
          <Field label="Bed type">
            <select
              value={form.bedTypeFilter}
              onChange={(e) =>
                setForm({ ...form, bedTypeFilter: e.target.value as "single" | "double", bedId: "", partnerBedId: "" })
              }
            >
              <option value="single">Single</option>
              <option value="double">Double</option>
            </select>
          </Field>
          <Field label="Bed">
            <select
              value={form.bedId}
              onChange={(e) => {
                const bedId = e.target.value;
                const pair = fallbackPairs.find((p) => String(p.bedId) === bedId);
                setForm({ ...form, bedId, partnerBedId: pair ? String(pair.partnerBedId) : "" });
              }}
            >
              <option value="">— unassigned —</option>
              {bedOptions.map((bed) => (
                <option key={bed.id} value={bed.id}>
                  {bed.type} — {bed.room.roomName}
                </option>
              ))}
              {fallbackPairs.map((pair) => (
                <option key={`fallback-${pair.bedId}`} value={pair.bedId}>
                  Single (auto-join) — {pair.roomName}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {form.bedTypeFilter === "double" && bedOptions.length === 0 && fallbackPairs.length > 0 && (
          <p className="tr-muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
            No pre-made doubles available — picking one of the above will automatically join two free Singles into a
            double from the arrival date.
          </p>
        )}

        <Field label="Shares bed with">
          <ShareBedSelect
            value={form.sharesBedWithBookingId}
            onChange={(id) => setForm({ ...form, sharesBedWithBookingId: id })}
            arrivalDate={form.arrivalDate}
            departureDate={form.departureDate}
          />
        </Field>
        {form.sharesBedWithBookingId != null && !form.bedId && (
          <p className="tr-muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
            Pick a Single bed above — the partner booking will automatically get the next bed down in the same room.
          </p>
        )}

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
