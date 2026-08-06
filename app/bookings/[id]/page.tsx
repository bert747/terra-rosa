"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { formatDateUk, isIsoDate, nightsBetween } from "@/lib/dates";
import DietaryTagInput from "@/components/DietaryTagInput";
import DateField from "@/components/DateField";
import SharesWithSelect, { SharesWithMode } from "@/components/SharesWithSelect";
import AllocationIssuesPanel from "@/components/AllocationIssuesPanel";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import SplitMergeConflictModal, { type SplitMergeConflictModalState } from "@/components/SplitMergeConflictModal";
import { useDietaryTagSuggestions } from "@/lib/use-dietary-tag-suggestions";

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

interface Booking {
  id: number;
  guestName: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  notes: string | null;
  arrivalDate: string;
  departureDate: string;
  linkedBookingId: number | null;
  sharesBedWithBookingId: number | null;
  splitGroupId: number | null;
  bedId: number | null;
  dietariesTags: string[] | null;
  guestType: string;
  allocationIssues: { otherBookingId: number; otherGuestName: string; kind: "room" | "bed" }[];
}

interface SplitSibling {
  id: number;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  bedId: number | null;
}

const GUEST_TYPES: { value: string; label: string }[] = [
  { value: "guest", label: "Guest" },
  { value: "resident", label: "Resident" },
  { value: "ashrami", label: "Ashrami" },
  { value: "friends_family", label: "Friends & Family" },
];

interface Draft {
  firstName: string;
  lastName: string;
  preferredName: string;
  notes: string;
  arrivalDate: string;
  departureDate: string;
  linkedBookingId: number | null;
  sharesBedWithBookingId: number | null;
  sharesWithMode: SharesWithMode;
  bedTypeFilter: "single" | "double";
  bedId: string;
  partnerBedId: string;
  guestType: string;
}

export default function BookingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id as string;
  // Preserves where the user actually came from — the grid links here with
  // ?from=grid so Back/Save and Exit return there instead of always
  // dropping back to the plain bookings list.
  const backHref = searchParams.get("from") === "grid" ? "/grid" : "/bookings";

  const [booking, setBooking] = useState<Booking | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [fallbackPairs, setFallbackPairs] = useState<FallbackPair[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);
  const dietarySuggestions = useDietaryTagSuggestions();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<SplitSibling[]>([]);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [splitMergeConflict, setSplitMergeConflict] = useState<SplitMergeConflictModalState | null>(null);
  const [merging, setMerging] = useState(false);
  // Bumped every load() — the bed-availability effect below keys off
  // draft's date/relationship fields, none of which change when a bed gets
  // reassigned from OUTSIDE the form (e.g. the allocation-issue "Fix"
  // action) — without this, bedOptions/bedTypeFilter would silently stay
  // stale and the Bed dropdown would keep showing the pre-fix state even
  // though the booking's own record (and the grid) already moved on.
  const [refreshToken, setRefreshToken] = useState(0);

  async function load() {
    const b: Booking = await fetch(`/api/bookings/${id}`).then((res) => res.json());
    setBooking(b);
    setDietaryTags(Array.isArray(b.dietariesTags) ? b.dietariesTags : []);
    setSiblings(b.splitGroupId != null ? await fetch(`/api/bookings/${id}/split-siblings`).then((res) => res.json()) : []);

    // Figure out which Bed Type filter actually shows this booking's own
    // bed, so re-opening an existing Double booking doesn't silently drop
    // its bed out of the visible options.
    let bedTypeFilter: "single" | "double" = "single";
    if (b.bedId) {
      const p = new URLSearchParams({ arrival: b.arrivalDate, departure: b.departureDate, excludeBookingId: id, bedType: "single" });
      if (b.sharesBedWithBookingId != null) p.set("shareBedWithBookingId", String(b.sharesBedWithBookingId));
      const singleData = await fetch(`/api/beds/available?${p}`).then((r) => r.json());
      const inSingle = (singleData.rows as BedOption[] | undefined)?.some((row) => row.id === b.bedId);
      if (!inSingle) bedTypeFilter = "double";
    }

    setDraft({
      firstName: b.firstName,
      lastName: b.lastName,
      preferredName: b.preferredName ?? "",
      notes: b.notes ?? "",
      arrivalDate: b.arrivalDate,
      departureDate: b.departureDate,
      linkedBookingId: b.linkedBookingId,
      sharesBedWithBookingId: b.sharesBedWithBookingId,
      sharesWithMode: b.sharesBedWithBookingId != null ? "bed" : "room",
      bedTypeFilter,
      bedId: b.bedId ? String(b.bedId) : "",
      partnerBedId: "",
      guestType: b.guestType ?? "guest",
    });
    setRefreshToken((t) => t + 1);
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
    if (draft.sharesBedWithBookingId != null) params.set("shareBedWithBookingId", String(draft.sharesBedWithBookingId));
    fetch(`/api/beds/available?${params}`)
      .then((r) => r.json())
      .then((data: { rows: BedOption[]; fallbackPairs: FallbackPair[] }) => {
        setBedOptions(data.rows);
        setFallbackPairs(data.fallbackPairs ?? []);
        // Deliberately NOT auto-cleared when the current bed falls out of
        // this list (dates/bed type changed) — that used to silently blank
        // the selection, which reads as an invisible deallocation once
        // saved. Left alone; a genuine conflict still surfaces as a real
        // error from the capacity check on save. See bedSelectOptions below
        // for how the dropdown keeps showing it even while it's missing
        // from `rows`.
      })
      .catch(() => {
        setBedOptions([]);
        setFallbackPairs([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.arrivalDate, draft?.departureDate, draft?.linkedBookingId, draft?.sharesBedWithBookingId, draft?.bedTypeFilter, id, refreshToken]);

  const hasUnsavedChanges = useMemo(() => {
    if (!booking || !draft) return false;
    return (
      booking.firstName !== draft.firstName ||
      booking.lastName !== draft.lastName ||
      (booking.preferredName ?? "") !== draft.preferredName ||
      (booking.notes ?? "") !== draft.notes ||
      booking.arrivalDate !== draft.arrivalDate ||
      booking.departureDate !== draft.departureDate ||
      (booking.linkedBookingId ?? null) !== draft.linkedBookingId ||
      (booking.sharesBedWithBookingId ?? null) !== draft.sharesBedWithBookingId ||
      (booking.bedId ? String(booking.bedId) : "") !== draft.bedId ||
      booking.guestType !== draft.guestType ||
      JSON.stringify(booking.dietariesTags ?? []) !== JSON.stringify(dietaryTags)
    );
  }, [booking, draft, dietaryTags]);

  async function saveChanges(propagateGuestType?: boolean): Promise<boolean> {
    if (!draft) return true;
    setSaving(true);
    setError(null);

    if (!draft.firstName.trim()) {
      setSaving(false);
      setError("First name is required.");
      return false;
    }
    if (!draft.arrivalDate || !draft.departureDate || draft.departureDate <= draft.arrivalDate) {
      setSaving(false);
      setError("Valid arrival/departure dates are required.");
      return false;
    }

    // Same rule as the New Booking form: picking a bed already labeled
    // "shares with X" is the deliberate pairing decision, and must be
    // finished through the confirmed-pairing endpoint (so
    // sharesBedWithBookingId gets set both ways) rather than a plain bedId
    // PATCH, which has no idea the bed is occupied. Only kicks in when the
    // bed selection actually changed to that bed.
    const chosenBed = bedOptions.find((b) => String(b.id) === draft.bedId);
    const bedChanged = (booking?.bedId ? String(booking.bedId) : "") !== draft.bedId;
    const directPairOccupant = bedChanged ? chosenBed?.sharesWith ?? null : null;

    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        preferredName: draft.preferredName.trim() || null,
        notes: draft.notes.trim() || null,
        arrivalDate: draft.arrivalDate,
        departureDate: draft.departureDate,
        linkedBookingId: draft.linkedBookingId,
        bedId: directPairOccupant ? (booking?.bedId ?? null) : draft.bedId || null,
        guestType: draft.guestType,
        propagateGuestType: propagateGuestType === true,
        dietariesTags: dietaryTags.length > 0 ? dietaryTags : null,
      }),
    });

    if (!res.ok) {
      setSaving(false);
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save booking changes.");
      return false;
    }

    if (directPairOccupant) {
      const pairRes = await fetch(`/api/bookings/${id}/pair-into-bed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          otherBookingId: directPairOccupant.bookingId,
          bedId: chosenBed!.id,
          arrivalDate: draft.arrivalDate,
          departureDate: draft.departureDate,
        }),
      });
      if (!pairRes.ok) {
        setSaving(false);
        const body = await pairRes.json().catch(() => ({}));
        setError(`Saved, but placing them in the bed failed: ${body.error ?? "unknown error"}`);
        return false;
      }
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

  // Every OTHER identity field (name, dietary tags, notes) is propagated to
  // the rest of a split's parts automatically server-side — see the PATCH
  // route's own comment — since it's still the same physical guest
  // throughout. guestType is the one exception staff need to weigh in on:
  // a stay can plausibly change classification partway through (e.g.
  // becoming a resident), which is a real, segment-specific fact, not a
  // typo to fix everywhere. Only asks when it's actually part of a split
  // AND the value actually changed — a no-op change or a plain, unsplit
  // booking just saves straight through.
  function requestSave(onDone: (ok: boolean) => void) {
    const guestTypeChanged = !!booking && !!draft && booking.guestType !== draft.guestType;
    if (booking?.splitGroupId != null && guestTypeChanged) {
      setConfirmModal({
        title: "Guest type changed",
        message: "This booking is part of a split stay. Change the guest type for this segment only, or for every segment of the split?",
        confirmLabel: "All segments",
        secondaryLabel: "This segment only",
        onConfirm: async () => onDone(await saveChanges(true)),
        onSecondary: async () => onDone(await saveChanges(false)),
      });
      return;
    }
    saveChanges().then(onDone);
  }

  async function saveAndExit() {
    requestSave((ok) => {
      if (ok) router.push(backHref);
    });
  }

  function deleteBooking() {
    setConfirmModal({
      title: "Delete booking?",
      message: `Delete ${booking?.guestName ?? "this"}'s booking? This can't be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        await fetch(`/api/bookings/${id}`, { method: "DELETE" });
        router.push(backHref);
      },
    });
  }

  async function mergeSplit() {
    setMerging(true);
    const res = await fetch(`/api/bookings/${id}/merge-split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    setMerging(false);
    if (res.status === 409 && Array.isArray(body.conflicts)) {
      setSplitMergeConflict({ bookingId: Number(id), conflicts: body.conflicts, canSwap: !!body.canSwap });
      return;
    }
    if (!res.ok) {
      setError(body.error ?? "Could not merge.");
      return;
    }
    afterMerge(body.resultBookingId);
  }

  async function resolveSplitMergeConflict(resolution: "swap" | "unallocate") {
    if (!splitMergeConflict) return;
    setMerging(true);
    const res = await fetch(`/api/bookings/${splitMergeConflict.bookingId}/merge-split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution }),
    });
    const body = await res.json().catch(() => ({}));
    setMerging(false);
    setSplitMergeConflict(null);
    if (!res.ok) {
      setError(body.error ?? "Could not merge.");
      return;
    }
    afterMerge(body.resultBookingId);
  }

  // A successful merge can delete the CURRENTLY-VIEWED booking's own row —
  // it becomes the later half of a now-contiguous pair, and that half's id
  // is always the one the coalescing step drops (see split-merge.ts). A
  // plain load() would then 404 against a row that no longer exists, so
  // navigate to wherever this booking's identity actually ended up instead.
  function afterMerge(resultBookingId: number | undefined) {
    if (resultBookingId != null && String(resultBookingId) !== id) {
      router.replace(`/bookings/${resultBookingId}${backHref === "/grid" ? "?from=grid" : ""}`);
    } else {
      load();
    }
  }

  if (!booking || !draft) {
    return (
      <div className="tr-shell">
        <p>Loading...</p>
      </div>
    );
  }

  const nights = nightsBetween(draft.arrivalDate, draft.departureDate);

  // The dropdown must never silently blank itself just because the current
  // bed fell out of `bedOptions` (see the effect above) — inject a
  // placeholder entry so the <select> keeps showing SOMETHING selected
  // instead of quietly reverting to "— unassigned —".
  const bedSelectOptions: BedOption[] =
    draft.bedId && !bedOptions.some((b) => String(b.id) === draft.bedId)
      ? [{ id: Number(draft.bedId), type: "Current bed", room: { roomId: 0, roomName: "no longer matches these dates/filters", floorId: 0, floorName: "" }, sharesWith: null }, ...bedOptions]
      : bedOptions;

  // Every part of this split lineage, including this one, in date order —
  // siblings alone don't say where THIS booking falls among them.
  const allParts: SplitSibling[] =
    booking.splitGroupId != null
      ? [...siblings, { id: booking.id, guestName: booking.guestName, arrivalDate: booking.arrivalDate, departureDate: booking.departureDate, bedId: booking.bedId }].sort(
          (a, b) => a.arrivalDate.localeCompare(b.arrivalDate)
        )
      : [];
  const myPartIndex = allParts.findIndex((p) => p.id === booking.id);
  const prevPart = myPartIndex > 0 ? allParts[myPartIndex - 1] : null;
  const nextPart = myPartIndex >= 0 && myPartIndex < allParts.length - 1 ? allParts[myPartIndex + 1] : null;
  const suffix = backHref === "/grid" ? "?from=grid" : "";

  return (
    <div className="tr-shell" style={{ maxWidth: 720 }}>
      <div className="tr-page-header">
        <h1 className="tr-page-title" style={{ margin: 0 }}>{booking.guestName}</h1>
        <a href={backHref} className="tr-back-link">← Back{backHref === "/grid" ? " to Grid" : " to Bookings"}</a>
      </div>

      {allParts.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, fontSize: 13 }}>
          <span className="tr-muted">
            This booking was split — part {myPartIndex + 1} of {allParts.length}
          </span>
          {prevPart && <a href={`/bookings/${prevPart.id}${suffix}`}>← Earlier part ({formatDateUk(prevPart.arrivalDate)})</a>}
          {nextPart && <a href={`/bookings/${nextPart.id}${suffix}`}>Next part ({formatDateUk(nextPart.arrivalDate)}) →</a>}
        </div>
      )}

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}
      <AllocationIssuesPanel bookingId={booking.id} issues={booking.allocationIssues} onApplied={load} />

      <div className="tr-card">
        <div className="tr-inline-grid-3">
          <Field label="First name">
            <input value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
          </Field>
          <Field label="Last name">
            <input value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
          </Field>
          <Field label="Preferred name">
            <input
              value={draft.preferredName}
              onChange={(e) => setDraft({ ...draft, preferredName: e.target.value })}
              placeholder="Optional — shown on the grid"
            />
          </Field>
        </div>

        <div className="tr-inline-grid-3">
          <Field label="Arrival date">
            <DateField value={draft.arrivalDate} onChange={(iso) => setDraft({ ...draft, arrivalDate: iso })} />
          </Field>
          <Field label="Departure date">
            <DateField value={draft.departureDate} onChange={(iso) => setDraft({ ...draft, departureDate: iso })} />
          </Field>
          <Field label="Guest type">
            <select value={draft.guestType} onChange={(e) => setDraft({ ...draft, guestType: e.target.value })}>
              {GUEST_TYPES.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </select>
          </Field>
        </div>

        <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
          {nights > 0 ? `${nights} ${nights === 1 ? "night" : "nights"}` : ""}
        </p>

        <div className="tr-inline-grid-3">
          <Field label="Bed type">
            <select
              value={draft.bedTypeFilter}
              onChange={(e) => setDraft({ ...draft, bedTypeFilter: e.target.value as "single" | "double", bedId: "", partnerBedId: "" })}
            >
              <option value="single">Single</option>
              <option value="double">Double</option>
            </select>
          </Field>
          <Field label="Shares with">
            <SharesWithSelect
              bookingId={draft.sharesWithMode === "bed" ? draft.sharesBedWithBookingId : draft.linkedBookingId}
              mode={draft.sharesWithMode}
              onChange={(id, mode) =>
                setDraft({
                  ...draft,
                  sharesWithMode: mode,
                  linkedBookingId: mode === "room" ? id : null,
                  sharesBedWithBookingId: mode === "bed" ? id : null,
                })
              }
              arrivalDate={draft.arrivalDate}
              departureDate={draft.departureDate}
              excludeBookingId={booking.id}
            />
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
              {bedSelectOptions.map((bed) => (
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

        <Field label="Dietary tags">
          <DietaryTagInput tags={dietaryTags} onChange={setDietaryTags} suggestions={dietarySuggestions} placeholder="e.g. Gluten-Free" />
        </Field>

        <Field label="Notes">
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            placeholder="Optional — shown as a corner marker on the grid pill"
            rows={2}
            style={{ resize: "vertical" }}
          />
        </Field>
      </div>

      <div className="tr-sticky-actions">
        <button type="button" className="tr-danger" onClick={deleteBooking}>Delete</button>
        {booking.splitGroupId != null && (
          <button type="button" onClick={mergeSplit} disabled={merging} data-tooltip="Merge every future part of this split back onto this bed">
            {merging ? "Merging…" : "Merge split parts onto this bed"}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => router.push(backHref)}>Back</button>
        <button type="button" className="primary" onClick={() => requestSave(() => {})} disabled={!hasUnsavedChanges || saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" className="primary" onClick={saveAndExit} disabled={saving}>
          Save and Exit
        </button>
      </div>

      <ConfirmModal state={confirmModal} onClose={() => setConfirmModal(null)} />
      <SplitMergeConflictModal
        state={splitMergeConflict}
        onClose={() => setSplitMergeConflict(null)}
        onResolve={resolveSplitMergeConflict}
      />
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
