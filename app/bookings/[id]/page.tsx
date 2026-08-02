"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
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

interface Booking {
  id: number;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  linkedBookingId: number | null;
  sharesBedWithBookingId: number | null;
  bedId: number | null;
  dietariesTags: string[] | null;
  guestType: string;
}

const GUEST_TYPES: { value: string; label: string }[] = [
  { value: "guest", label: "Guest" },
  { value: "resident", label: "Resident" },
  { value: "ashrami", label: "Ashrami" },
];

interface Draft {
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  linkedBookingId: number | null;
  sharesBedWithBookingId: number | null;
  bedTypeFilter: "single" | "double";
  bedId: string;
  partnerBedId: string;
  guestType: string;
}

export default function BookingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [booking, setBooking] = useState<Booking | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [fallbackPairs, setFallbackPairs] = useState<FallbackPair[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const b: Booking = await fetch(`/api/bookings/${id}`).then((res) => res.json());
    setBooking(b);
    setDietaryTags(Array.isArray(b.dietariesTags) ? b.dietariesTags : []);

    // Figure out which Bed Type filter actually shows this booking's own
    // bed, so re-opening an existing Double booking doesn't silently drop
    // its bed out of the visible options.
    let bedTypeFilter: "single" | "double" = "single";
    if (b.bedId) {
      const p = new URLSearchParams({ arrival: b.arrivalDate, departure: b.departureDate, excludeBookingId: id, bedType: "single" });
      const singleData = await fetch(`/api/beds/available?${p}`).then((r) => r.json());
      const inSingle = (singleData.rows as BedOption[] | undefined)?.some((row) => row.id === b.bedId);
      if (!inSingle) bedTypeFilter = "double";
    }

    setDraft({
      guestName: b.guestName,
      arrivalDate: b.arrivalDate,
      departureDate: b.departureDate,
      linkedBookingId: b.linkedBookingId,
      sharesBedWithBookingId: b.sharesBedWithBookingId,
      bedTypeFilter,
      bedId: b.bedId ? String(b.bedId) : "",
      partnerBedId: "",
      guestType: b.guestType ?? "guest",
    });
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!draft) return;
    if (!isIsoDate(draft.arrivalDate) || !isIsoDate(draft.departureDate) || draft.departureDate <= draft.arrivalDate) {
      setBedOptions([]);
      setFallbackPairs([]);
      return;
    }
    const params = new URLSearchParams({
      arrival: draft.arrivalDate,
      departure: draft.departureDate,
      excludeBookingId: id,
      bedType: draft.bedTypeFilter,
    });
    if (draft.linkedBookingId != null) params.set("nearBookingId", String(draft.linkedBookingId));
    fetch(`/api/beds/available?${params}`)
      .then((r) => r.json())
      .then((data: { rows: BedOption[]; fallbackPairs: FallbackPair[] }) => {
        setBedOptions(data.rows);
        setFallbackPairs(data.fallbackPairs ?? []);
        setDraft((d) =>
          d && d.bedId && !data.rows.some((row) => String(row.id) === d.bedId) ? { ...d, bedId: "", partnerBedId: "" } : d
        );
      })
      .catch(() => {
        setBedOptions([]);
        setFallbackPairs([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.arrivalDate, draft?.departureDate, draft?.linkedBookingId, draft?.bedTypeFilter, id]);

  const hasUnsavedChanges = useMemo(() => {
    if (!booking || !draft) return false;
    return (
      booking.guestName !== draft.guestName ||
      booking.arrivalDate !== draft.arrivalDate ||
      booking.departureDate !== draft.departureDate ||
      (booking.linkedBookingId ?? null) !== draft.linkedBookingId ||
      (booking.sharesBedWithBookingId ?? null) !== draft.sharesBedWithBookingId ||
      (booking.bedId ? String(booking.bedId) : "") !== draft.bedId ||
      booking.guestType !== draft.guestType ||
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
        linkedBookingId: draft.linkedBookingId,
        bedId: draft.bedId || null,
        guestType: draft.guestType,
        dietariesTags: dietaryTags.length > 0 ? dietaryTags : null,
      }),
    });

    if (!res.ok) {
      setSaving(false);
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save booking changes.");
      return false;
    }

    // Auto-Join Fallback: a fallback pair was picked in the Bed dropdown —
    // join the two Singles into a double from this booking's arrival date.
    if (draft.partnerBedId && draft.bedId) {
      const joinRes = await fetch("/api/joined-beds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bed1Id: Number(draft.bedId), bed2Id: Number(draft.partnerBedId), mode: "double", startDate: draft.arrivalDate }),
      });
      if (!joinRes.ok) {
        setSaving(false);
        const body = await joinRes.json().catch(() => ({}));
        setError(`Saved, but auto-join failed: ${body.error ?? "unknown error"}`);
        return false;
      }
    }

    const sharesChanged = (booking?.sharesBedWithBookingId ?? null) !== draft.sharesBedWithBookingId;
    if (sharesChanged && draft.sharesBedWithBookingId != null && draft.bedId) {
      const shareRes = await fetch(`/api/bookings/${id}/share-bed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerBookingId: draft.sharesBedWithBookingId }),
      });
      if (!shareRes.ok) {
        setSaving(false);
        const body = await shareRes.json().catch(() => ({}));
        setError(`Saved, but Shares Bed With failed: ${body.error ?? "unknown error"}`);
        return false;
      }
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
            <DateField value={draft.arrivalDate} onChange={(iso) => setDraft({ ...draft, arrivalDate: iso })} />
          </Field>
          <Field label="Departure date">
            <DateField value={draft.departureDate} onChange={(iso) => setDraft({ ...draft, departureDate: iso })} />
          </Field>
        </div>

        <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
          {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : ""}
        </p>

        <Field label="Guest type">
          <select value={draft.guestType} onChange={(e) => setDraft({ ...draft, guestType: e.target.value })}>
            {GUEST_TYPES.map((g) => (
              <option key={g.value} value={g.value}>{g.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Sleeps near / Linked with">
          <LinkedBookingSelect
            value={draft.linkedBookingId}
            onChange={(id) => setDraft({ ...draft, linkedBookingId: id })}
            arrivalDate={draft.arrivalDate}
            departureDate={draft.departureDate}
            excludeBookingId={booking.id}
          />
        </Field>

        <div className="tr-inline-grid">
          <Field label="Bed type">
            <select
              value={draft.bedTypeFilter}
              onChange={(e) => setDraft({ ...draft, bedTypeFilter: e.target.value as "single" | "double", bedId: "", partnerBedId: "" })}
            >
              <option value="single">Single</option>
              <option value="double">Double</option>
            </select>
          </Field>
          <Field label="Bed">
            <select
              value={draft.bedId}
              onChange={(e) => {
                const bedId = e.target.value;
                const pair = fallbackPairs.find((p) => String(p.bedId) === bedId);
                setDraft({ ...draft, bedId, partnerBedId: pair ? String(pair.partnerBedId) : "" });
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

        <Field label="Shares bed with">
          <ShareBedSelect
            value={draft.sharesBedWithBookingId}
            onChange={(id) => setDraft({ ...draft, sharesBedWithBookingId: id })}
            arrivalDate={draft.arrivalDate}
            departureDate={draft.departureDate}
            excludeBookingId={booking.id}
          />
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
