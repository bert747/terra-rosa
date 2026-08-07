"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDateUk, isIsoDate, nightsBetween } from "@/lib/dates";
import DietaryTagInput from "@/components/DietaryTagInput";
import DateField from "@/components/DateField";
import SharesWithSelect, { SharesWithMode } from "@/components/SharesWithSelect";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import { useDietaryTagSuggestions } from "@/lib/use-dietary-tag-suggestions";
import { useGuestCategories } from "@/lib/use-guest-categories";
import GuestTypeSelect from "@/components/GuestTypeSelect";

interface BedOption {
  id: number;
  type: string;
  room: { roomId: number; roomName: string; floorId: number; floorName: string };
  sharesWith: { bookingId: number; guestName: string; arrivalDate: string; departureDate: string } | null;
}

function bedOptionLabel(bed: BedOption): string {
  const base = `${bed.type} — ${bed.room.roomName}`;
  if (!bed.sharesWith) return base;
  return `${base} (shares with ${bed.sharesWith.guestName}, ${formatDateUk(bed.sharesWith.arrivalDate)}–${formatDateUk(bed.sharesWith.departureDate)})`;
}

interface FallbackPair {
  bedId: number;
  partnerBedId: number;
  roomId: number;
  roomName: string;
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
  // ?from=grid so Save/Cancel return there instead of always landing on the
  // bookings list — same convention the edit page already uses.
  const backHref = search.get("from") === "grid" ? "/grid" : "/bookings";

  const arrivalDefault = prefillArrival || new Date().toISOString().slice(0, 10);
  const departureDefault = prefillDeparture || addDaysIso(arrivalDefault, 1);

  const [error, setError] = useState<string | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [fallbackPairs, setFallbackPairs] = useState<FallbackPair[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    preferredName: "",
    notes: "",
    arrivalDate: arrivalDefault,
    departureDate: departureDefault,
    sharesWithId: null as number | null,
    sharesWithMode: "room" as SharesWithMode,
    bedTypeFilter: "single" as "single" | "double",
    bedId: prefillBedId,
    partnerBedId: "" as string,
    guestCategoryId: "" as string,
  });
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);
  const dietarySuggestions = useDietaryTagSuggestions();
  const guestCategories = useGuestCategories().filter((c) => c.active);
  // Live preview of the selected guest type's colour — see the identical
  // pattern (and its own longer comment) on the booking edit page.
  const selectedGuestCategoryColour = form.guestCategoryId
    ? guestCategories.find((c) => String(c.id) === form.guestCategoryId)?.colour ?? null
    : null;

  useEffect(() => {
    if (!isIsoDate(form.arrivalDate) || !isIsoDate(form.departureDate) || form.departureDate <= form.arrivalDate) {
      setBedOptions([]);
      setFallbackPairs([]);
      return;
    }
    const params = new URLSearchParams({ arrival: form.arrivalDate, departure: form.departureDate, bedType: form.bedTypeFilter });
    if (form.sharesWithMode === "room" && form.sharesWithId != null) params.set("nearBookingId", String(form.sharesWithId));
    if (form.sharesWithMode === "bed" && form.sharesWithId != null) params.set("shareBedWithBookingId", String(form.sharesWithId));
    fetch(`/api/beds/available?${params}`)
      .then((r) => r.json())
      .then((data: { rows: BedOption[]; fallbackPairs: FallbackPair[] }) => {
        setBedOptions(data.rows);
        setFallbackPairs(data.fallbackPairs ?? []);
        // The previously-picked bed can fall out of this list when the
        // dates/bed type change or a "sleeps near" pick narrows it to a
        // different room — deliberately NOT auto-cleared here: silently
        // dropping a selection the user can't see happen is worse than
        // leaving it and letting the real capacity check on submit catch a
        // genuine conflict.
      })
      .catch(() => {
        setBedOptions([]);
        setFallbackPairs([]);
      });
  }, [form.arrivalDate, form.departureDate, form.sharesWithId, form.sharesWithMode, form.bedTypeFilter]);

  const nights = nightsBetween(form.arrivalDate, form.departureDate);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.firstName.trim()) {
      setError("First name is required.");
      return;
    }
    if (!form.arrivalDate || !form.departureDate || form.departureDate <= form.arrivalDate) {
      setError("Valid arrival/departure dates are required.");
      return;
    }

    // Picking a bed the dropdown already labeled "shares with X" is a real
    // decision worth a beat to confirm — staff can pick the wrong row in a
    // dropdown as easily as anywhere else, and undoing a same-bed pairing
    // after the fact is more work than catching it here. "No" clears the
    // pick entirely (bed AND the Shares With fields it just auto-filled)
    // rather than leaving a half-set, confusing state — see the bed
    // <select>'s own onChange for where that auto-fill happens.
    const chosenBed = bedOptions.find((b) => String(b.id) === form.bedId);
    const directPairOccupant = chosenBed?.sharesWith ?? null;
    if (directPairOccupant) {
      setConfirmModal({
        title: "Share a bed?",
        message: `Do you want ${form.firstName.trim() || "this guest"} to share a bed with ${directPairOccupant.guestName}?`,
        confirmLabel: "Yes, share the bed",
        secondaryLabel: "No, choose another bed",
        onConfirm: () => performSubmit(),
        onSecondary: () => {
          setForm((f) => ({ ...f, bedId: "", partnerBedId: "", sharesWithId: null, sharesWithMode: "room" }));
        },
      });
      return;
    }
    performSubmit();
  }

  async function performSubmit() {
    setSaving(true);
    setError(null);

    const chosenBed = bedOptions.find((b) => String(b.id) === form.bedId);
    const directPairOccupant = chosenBed?.sharesWith ?? null;

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        preferredName: form.preferredName.trim() || null,
        notes: form.notes.trim() || null,
        arrivalDate: form.arrivalDate,
        departureDate: form.departureDate,
        linkedBookingId: form.sharesWithMode === "room" ? form.sharesWithId : null,
        bedId: directPairOccupant ? null : form.bedId || null,
        partnerBedId: form.partnerBedId || null,
        guestCategoryId: form.guestCategoryId || null,
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

    if (directPairOccupant) {
      const pairRes = await fetch(`/api/bookings/${booking.id}/pair-into-bed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          otherBookingId: directPairOccupant.bookingId,
          bedId: chosenBed!.id,
          arrivalDate: form.arrivalDate,
          departureDate: form.departureDate,
        }),
      });
      if (!pairRes.ok) {
        setSaving(false);
        const body = await pairRes.json().catch(() => ({}));
        setError(`Booking created, but placing them in the bed failed: ${body.error ?? "unknown error"}`);
        return;
      }
    } else if (form.sharesWithMode === "bed" && form.sharesWithId != null && form.bedId) {
      const shareRes = await fetch(`/api/bookings/${booking.id}/share-bed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerBookingId: form.sharesWithId }),
      });
      if (!shareRes.ok) {
        setSaving(false);
        const body = await shareRes.json().catch(() => ({}));
        setError(`Booking created, but Shares Bed With failed: ${body.error ?? "unknown error"}`);
        return;
      }
    }

    setSaving(false);
    router.push(backHref);
  }

  return (
    <div className="tr-shell" style={{ maxWidth: 720 }}>
      <h1 className="tr-page-title">New booking</h1>
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}
      <ConfirmModal state={confirmModal} onClose={() => setConfirmModal(null)} />

      <form
        onSubmit={handleSubmit}
        className="tr-card"
        style={
          selectedGuestCategoryColour
            ? { boxShadow: `inset 0 16px 0 ${selectedGuestCategoryColour}, 0 6px 18px rgba(70, 54, 31, 0.06)` }
            : undefined
        }
      >
        <div className="tr-inline-grid-3">
          <Field label="First name" required>
            <input
              required
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            />
          </Field>
          <Field label="Last name">
            <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </Field>
          <Field label="Preferred name">
            <input
              value={form.preferredName}
              onChange={(e) => setForm({ ...form, preferredName: e.target.value })}
              placeholder="Optional — shown on the grid"
            />
          </Field>
        </div>

        <div className="tr-inline-grid-3">
          <Field label="Arrival date" required>
            <DateField required value={form.arrivalDate} onChange={(iso) => setForm({ ...form, arrivalDate: iso })} />
          </Field>
          <Field label="Departure date" required>
            <DateField required value={form.departureDate} onChange={(iso) => setForm({ ...form, departureDate: iso })} />
          </Field>
          <Field label="Guest type">
            <GuestTypeSelect
              categories={guestCategories}
              value={form.guestCategoryId}
              onChange={(v) => setForm({ ...form, guestCategoryId: v })}
            />
          </Field>
        </div>

        <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
          {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : "Select both dates."}
        </p>

        <div className="tr-inline-grid-3">
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
          <Field label="Shares with">
            <SharesWithSelect
              bookingId={form.sharesWithId}
              mode={form.sharesWithMode}
              onChange={(id, mode) => setForm({ ...form, sharesWithId: id, sharesWithMode: mode })}
              arrivalDate={form.arrivalDate}
              departureDate={form.departureDate}
            />
          </Field>
          <Field label="Bed">
            <select
              value={form.bedId}
              onChange={(e) => {
                const bedId = e.target.value;
                const pair = fallbackPairs.find((p) => String(p.bedId) === bedId);
                const chosen = bedOptions.find((b) => String(b.id) === bedId);
                setForm({
                  ...form,
                  bedId,
                  partnerBedId: pair ? String(pair.partnerBedId) : "",
                  // Picking a bed that's already got someone in it (a native
                  // double/1.5-bed's free slot) IS the "shares with, same
                  // bed" decision — reflect that in the Shares With field
                  // itself instead of leaving it looking untouched while the
                  // pairing happens invisibly underneath. Only auto-fills;
                  // never overwrites a Shares With the guest had already
                  // picked some other way.
                  ...(chosen?.sharesWith ? { sharesWithId: chosen.sharesWith.bookingId, sharesWithMode: "bed" as SharesWithMode } : {}),
                });
              }}
            >
              <option value="">— unassigned —</option>
              {bedOptions.map((bed) => (
                <option key={bed.id} value={bed.id}>
                  {bedOptionLabel(bed)}
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

        {form.sharesWithMode === "bed" && form.sharesWithId != null && !form.bedId && (
          <p className="tr-muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
            Pick a Single bed above — the partner booking will automatically get the next bed down in the same room.
          </p>
        )}

        <Field label="Dietary tags">
          <DietaryTagInput tags={dietaryTags} onChange={setDietaryTags} suggestions={dietarySuggestions} placeholder="e.g. Gluten-Free" />
        </Field>

        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Optional — shown as an icon on the grid pill"
            rows={2}
            style={{ resize: "vertical" }}
          />
        </Field>

        <div className="tr-form-actions">
          <button type="button" onClick={() => router.push(backHref)}>Cancel</button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving..." : "Create booking"}
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
