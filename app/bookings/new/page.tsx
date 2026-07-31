"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDateUk, isIsoDate, nightsBetween } from "@/lib/dates";
import { joinDietaryTags, splitDietaryTags } from "@/lib/dietary-tags";
import DietaryTagInput from "@/components/DietaryTagInput";

interface BedOption {
  value: string;
  roomId: number;
  bedNumber: number;
  label: string;
  occupied: boolean;
  warning: string | null;
}

interface RoomSuggestion {
  roomId: number | null;
  roomName?: string;
  locationOrType?: string | null;
}

interface ExtraGuestRow {
  name: string;
  dietaryRequirements: string;
}

const BOOKING_STATUSES = [
  { value: "draft", label: "Provisional" },
  { value: "confirmed", label: "Confirmed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

type BookingStatus = (typeof BOOKING_STATUSES)[number]["value"];

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

function parseBedSelection(value: string): { roomId: string; preferredBed: string } {
  if (!value.includes(":")) return { roomId: "", preferredBed: "" };
  const [roomId, bedNumber] = value.split(":");
  return { roomId, preferredBed: bedNumber };
}

function NewBookingForm() {
  const router = useRouter();
  const search = useSearchParams();

  const prefillCheckIn = dateParam(search.get("checkIn"));

  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<RoomSuggestion | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [selectedBedValue, setSelectedBedValue] = useState("");
  const [saving, setSaving] = useState(false);

  const checkInDefault = prefillCheckIn || new Date().toISOString().slice(0, 10);
  const checkOutDefault = addDaysIso(checkInDefault, 7);

  const [form, setForm] = useState({
    leadGuestName: "",
    contactPhone: "",
    contactEmail: "",
    checkInDate: checkInDefault,
    checkOutDate: checkOutDefault,
    bookingType: "guest",
    status: "confirmed" as BookingStatus,
    roomId: "",
    preferredBed: "",
    leadDietaryRequirements: "",
    notes: "",
  });

  const [extraGuests, setExtraGuests] = useState<ExtraGuestRow[]>([]);
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/dietary/tags")
      .then((r) => r.json())
      .then((payload: { tags?: string[] }) => setDietaryTags(payload.tags ?? []))
      .catch(() => setDietaryTags([]));
  }, []);

  const partySize = useMemo(
    () => 1 + extraGuests.filter((g) => g.name.trim()).length,
    [extraGuests]
  );

  useEffect(() => {
    if (form.status !== "confirmed") {
      setSuggestion(null);
      setBedOptions([]);
      setSelectedBedValue("");
      return;
    }

    if (!form.checkInDate || !form.checkOutDate || form.checkOutDate <= form.checkInDate) {
      setSuggestion(null);
      setBedOptions([]);
      setSelectedBedValue("");
      return;
    }

    const controller = new AbortController();

    fetch(
      `/api/rooms/first-free?checkIn=${form.checkInDate}&checkOut=${form.checkOutDate}&guestCount=${partySize}`,
      { signal: controller.signal }
    )
      .then((r) => r.json())
      .then((data: RoomSuggestion) => setSuggestion(data))
      .catch((err) => {
        if (err?.name !== "AbortError") setSuggestion(null);
      });

    fetch(
      `/api/rooms/bed-options?checkIn=${form.checkInDate}&checkOut=${form.checkOutDate}`,
      { signal: controller.signal }
    )
      .then((r) => r.json())
      .then((data: { options: BedOption[] }) => {
        const options = data.options ?? [];
        setBedOptions(options);

        if (!selectedBedValue) {
          const firstFree = options.find((o) => !o.occupied) ?? null;
          if (firstFree) {
            setSelectedBedValue(firstFree.value);
            const parsed = parseBedSelection(firstFree.value);
            setForm((f) => ({ ...f, roomId: parsed.roomId, preferredBed: parsed.preferredBed }));
          }
        }
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setBedOptions([]);
      });

    return () => controller.abort();
  }, [form.status, form.checkInDate, form.checkOutDate, partySize, selectedBedValue]);

  const stayNights = useMemo(
    () => nightsBetween(form.checkInDate, form.checkOutDate),
    [form.checkInDate, form.checkOutDate]
  );

  function updateExtraGuest(index: number, patch: Partial<ExtraGuestRow>) {
    setExtraGuests((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function setPreferredBedIfNeeded(bookingId: number, preferredBed: number | null) {
    if (!preferredBed) return;

    const segments = await fetch(`/api/segments?bookingId=${bookingId}`).then((r) => r.json());
    const segment = Array.isArray(segments) ? segments[0] : null;
    if (!segment?.id) return;

    await fetch(`/api/segments/${segment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredBed }),
    });
  }

  async function createOneBooking(payload: {
    leadGuestName: string;
    dietaryRequirements: string;
    preferredBed: number | null;
  }) {
    const guests = payload.dietaryRequirements.trim()
      ? [{ name: payload.leadGuestName, dietaryRequirements: payload.dietaryRequirements.trim() }]
      : [];

    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadGuestName: payload.leadGuestName,
        contactPhone: form.contactPhone,
        contactEmail: form.contactEmail,
        guestCount: 1,
        checkInDate: form.checkInDate,
        checkOutDate: form.checkOutDate,
        bookingType: form.bookingType,
        status: form.status,
        roomId: form.status === "confirmed" ? form.roomId || null : null,
        notes: form.notes,
        guests,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not create booking.");
    }

    const created = await res.json();
    await setPreferredBedIfNeeded(created.id, payload.preferredBed);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    if (!form.leadGuestName.trim()) {
      setSaving(false);
      setError("Lead guest name is required.");
      return;
    }
    if (!form.checkInDate || !form.checkOutDate || form.checkOutDate <= form.checkInDate) {
      setSaving(false);
      setError("Valid check-in/check-out dates are required.");
      return;
    }

    const selectedOption = bedOptions.find((o) => o.value === selectedBedValue) ?? null;
    if (form.status === "confirmed" && selectedOption?.occupied && selectedOption.warning) {
      const proceed = confirm(`Warning: ${selectedOption.warning}\n\nDo you want to continue anyway?`);
      if (!proceed) {
        setSaving(false);
        return;
      }
    }

    if (form.status === "confirmed" && !form.roomId) {
      const proceed = confirm("Warning: confirmed booking has no room assigned. Continue?");
      if (!proceed) {
        setSaving(false);
        return;
      }
    }

    const additional = extraGuests.filter((g) => g.name.trim());

    try {
      await createOneBooking({
        leadGuestName: form.leadGuestName.trim(),
        dietaryRequirements: form.leadDietaryRequirements,
        preferredBed: form.preferredBed.trim() ? Number(form.preferredBed) : null,
      });

      for (const guest of additional) {
        await createOneBooking({
          leadGuestName: guest.name.trim(),
          dietaryRequirements: guest.dietaryRequirements,
          preferredBed: null,
        });
      }
    } catch (err: any) {
      setSaving(false);
      setError(err?.message ?? "Could not create booking(s).");
      return;
    }

    setSaving(false);
    router.push("/bookings");
  }

  return (
    <div className="tr-shell" style={{ maxWidth: 1080 }}>
      <h1 className="tr-page-title">New Booking</h1>
      {prefillCheckIn && (
        <p className="tr-muted" style={{ marginTop: -6, marginBottom: 12 }}>
          Prefilled from the grid for {formatDateUk(prefillCheckIn)}.
        </p>
      )}
      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <form onSubmit={handleSubmit} className="tr-card">
        <div className="tr-form-grid">
          <section className="tr-form-section">
            <h2 className="tr-section-title">Stay Details</h2>

            <div className="tr-inline-grid">
              <Field label="Check-in date" required>
                <input
                  type="date"
                  required
                  value={form.checkInDate}
                  onChange={(e) => setForm({ ...form, checkInDate: e.target.value })}
                />
              </Field>
              <Field label="Check-out date" required>
                <input
                  type="date"
                  required
                  value={form.checkOutDate}
                  onChange={(e) => setForm({ ...form, checkOutDate: e.target.value })}
                />
              </Field>
            </div>

            <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
              {stayNights > 0
                ? `${stayNights} ${stayNights === 1 ? "night" : "nights"} (${formatDateUk(form.checkInDate)} to ${formatDateUk(form.checkOutDate)})`
                : "Select both dates to calculate length of stay."}
            </p>

            <Field label="Bed assignment" required>
              <select
                value={selectedBedValue}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  const next = bedOptions.find((o) => o.value === nextValue);
                  if (!next) {
                    setSelectedBedValue("");
                    setForm((f) => ({ ...f, roomId: "", preferredBed: "" }));
                    return;
                  }

                  if (next.occupied && next.warning) {
                    const proceed = confirm(`Warning: ${next.warning}\n\nSelect this bed anyway?`);
                    if (!proceed) return;
                  }

                  setSelectedBedValue(nextValue);
                  const parsed = parseBedSelection(nextValue);
                  setForm((f) => ({ ...f, roomId: parsed.roomId, preferredBed: parsed.preferredBed }));
                }}
                disabled={form.status !== "confirmed"}
              >
                <option value="">- select bed -</option>
                {bedOptions.map((opt) => (
                  <option key={opt.value} value={opt.value} style={{ color: opt.occupied ? "#777" : "#2f3b2e" }}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>

            {form.status === "confirmed" && suggestion?.roomId && (
              <p className="tr-muted" style={{ marginTop: 0, marginBottom: 10 }}>
                Suggested room for party: {suggestion.roomName}
                {suggestion.locationOrType ? ` (${suggestion.locationOrType})` : ""}
              </p>
            )}

            <div className="tr-inline-grid">
              <Field label="Booking type">
                <select value={form.bookingType} onChange={(e) => setForm({ ...form, bookingType: e.target.value })}>
                  <option value="guest">Guest</option>
                  <option value="resident">Resident</option>
                  <option value="guardian">Guardian</option>
                  <option value="worker">Worker</option>
                </select>
              </Field>

              <Field label="Status" required>
                <div className="tr-status-toggle" role="group" aria-label="Booking status">
                  {BOOKING_STATUSES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      className={`tr-chip${form.status === s.value ? " tr-chip-active" : ""}`}
                      onClick={() => setForm({ ...form, status: s.value })}
                      aria-pressed={form.status === s.value}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </section>

          <section className="tr-form-section">
            <h2 className="tr-section-title">Guest Information</h2>

            <Field label="Lead guest name" required>
              <input
                required
                value={form.leadGuestName}
                onChange={(e) => setForm({ ...form, leadGuestName: e.target.value })}
                placeholder="Full name"
              />
            </Field>

            <div className="tr-inline-grid">
              <Field label="Contact phone">
                <input
                  type="tel"
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                  placeholder="Phone number"
                />
              </Field>
              <Field label="Contact email" required>
                <input
                  type="email"
                  required
                  value={form.contactEmail}
                  onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                  placeholder="name@example.com"
                />
              </Field>
            </div>

            <Field label="Lead guest dietary requirements">
              <DietaryTagInput
                tags={splitDietaryTags(form.leadDietaryRequirements)}
                onChange={(tags) => setForm({ ...form, leadDietaryRequirements: joinDietaryTags(tags) })}
                suggestions={dietaryTags}
                placeholder="e.g. Gluten-Free"
              />
            </Field>

            {extraGuests.length > 0 && (
              <div style={{ overflowX: "auto", marginBottom: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Additional guest name</th>
                      <th>Dietary requirements</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {extraGuests.map((row, index) => (
                      <tr key={`extra-guest-${index}`}>
                        <td>
                          <input
                            value={row.name}
                            onChange={(e) => updateExtraGuest(index, { name: e.target.value })}
                            placeholder="Guest name"
                            style={{ width: 220 }}
                          />
                        </td>
                        <td style={{ minWidth: 220 }}>
                          <DietaryTagInput
                            tags={splitDietaryTags(row.dietaryRequirements)}
                            onChange={(tags) => updateExtraGuest(index, { dietaryRequirements: joinDietaryTags(tags) })}
                            suggestions={dietaryTags}
                            placeholder="e.g. Gluten-Free"
                          />
                        </td>
                        <td>
                          <button type="button" onClick={() => setExtraGuests((rows) => rows.filter((_, i) => i !== index))}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <button type="button" onClick={() => setExtraGuests((rows) => [...rows, { name: "", dietaryRequirements: "" }])}>
              Add a Guest
            </button>

            <p className="tr-muted" style={{ marginTop: 8, marginBottom: 0 }}>
              This creates {partySize} separate booking line{partySize === 1 ? "" : "s"}.
            </p>
          </section>
        </div>

        <section className="tr-form-section" style={{ marginTop: 12 }}>
          <h2 className="tr-section-title">Dietary and Notes</h2>
          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={4}
              placeholder="Arrival details, transport notes, preferences..."
            />
          </Field>
        </section>

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
