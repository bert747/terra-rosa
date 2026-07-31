"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { formatDateUk, nightsBetween } from "@/lib/dates";
import { joinDietaryTags, splitDietaryTags } from "@/lib/dietary-tags";
import DietaryTagInput from "@/components/DietaryTagInput";

interface Room {
  id: number;
  name: string;
  defaultBedCount: number;
}

interface Segment {
  id: number;
  roomId: number;
  preferredBed: number | null;
  startDate: string;
  endDate: string;
  guestCount: number;
}

interface SegmentPatch {
  roomId?: number;
  preferredBed?: number | null;
  startDate?: string;
  endDate?: string;
  guestCount?: number;
}

interface Person {
  id: number;
  name: string;
  dietaryRequirements: string | null;
}

interface Booking {
  id: number;
  leadGuestName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  checkInDate: string;
  checkOutDate: string | null;
  bookingType: string;
  status: "draft" | "confirmed" | "cancelled";
  notes: string | null;
  segments: Segment[];
  guests: Person[];
}

interface BookingDraft {
  leadGuestName: string;
  contactPhone: string;
  contactEmail: string;
  checkInDate: string;
  checkOutDate: string;
  roomId: string;
  preferredBed: string;
  bookingType: string;
  status: "draft" | "confirmed" | "cancelled";
  dietaryRequirements: string;
  notes: string;
}

interface BedOption {
  value: string;
  roomId: number;
  bedNumber: number;
  label: string;
  occupied: boolean;
  warning: string | null;
}

function parseBedSelection(value: string): { roomId: string; preferredBed: string } {
  if (!value.includes(":")) return { roomId: "", preferredBed: "" };
  const [roomId, bedNumber] = value.split(":");
  return { roomId, preferredBed: bedNumber };
}

export default function BookingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [booking, setBooking] = useState<Booking | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [draft, setDraft] = useState<BookingDraft | null>(null);
  const [bedOptions, setBedOptions] = useState<BedOption[]>([]);
  const [selectedBedValue, setSelectedBedValue] = useState("");
  const [dietaryTags, setDietaryTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newSegment, setNewSegment] = useState({
    roomId: "",
    preferredBed: "",
    startDate: "",
    endDate: "",
  });

  const sortedSegments = useMemo(
    () =>
      (booking?.segments ?? [])
        .slice()
        .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id),
    [booking?.segments]
  );

  const primarySegment = sortedSegments[0] ?? null;
  const primaryGuest = booking?.guests?.[0] ?? null;

  async function load() {
    const [b, r] = await Promise.all([
      fetch(`/api/bookings/${id}`).then((res) => res.json()),
      fetch("/api/rooms").then((res) => res.json()),
    ]);

    const segment = (b.segments ?? [])
      .slice()
      .sort((a: Segment, c: Segment) => a.startDate.localeCompare(c.startDate) || a.id - c.id)[0] ?? null;

    const guest = (b.guests ?? [])[0] ?? null;

    setBooking(b);
    setRooms(r.filter((room: any) => room.isActive));
    setDraft({
      leadGuestName: b.leadGuestName,
      contactPhone: b.contactPhone ?? "",
      contactEmail: b.contactEmail ?? "",
      checkInDate: b.checkInDate,
      checkOutDate: b.checkOutDate ?? "",
      roomId: segment?.roomId ? String(segment.roomId) : "",
      preferredBed: segment?.preferredBed ? String(segment.preferredBed) : "",
      bookingType: b.bookingType,
      status: b.status,
      dietaryRequirements: guest?.dietaryRequirements ?? "",
      notes: b.notes ?? "",
    });

    setSelectedBedValue(segment?.roomId && segment?.preferredBed ? `${segment.roomId}:${segment.preferredBed}` : "");
    setNewSegment({
      roomId: "",
      preferredBed: "",
      startDate: b.checkInDate,
      endDate: b.checkOutDate ?? "",
    });
  }

  useEffect(() => {
    load();
  }, [id]);

  useEffect(() => {
    fetch("/api/dietary/tags")
      .then((r) => r.json())
      .then((payload: { tags?: string[] }) => setDietaryTags(payload.tags ?? []))
      .catch(() => setDietaryTags([]));
  }, []);

  useEffect(() => {
    if (!draft || draft.status !== "confirmed") {
      setBedOptions([]);
      return;
    }
    if (!draft.checkInDate || !draft.checkOutDate || draft.checkOutDate <= draft.checkInDate) {
      setBedOptions([]);
      return;
    }

    const controller = new AbortController();
    fetch(
      `/api/rooms/bed-options?checkIn=${draft.checkInDate}&checkOut=${draft.checkOutDate}&excludeBookingId=${id}`,
      { signal: controller.signal }
    )
      .then((r) => r.json())
      .then((data: { options: BedOption[] }) => {
        const options = data.options ?? [];
        setBedOptions(options);

        if (!selectedBedValue && options.length > 0) {
          const firstFree = options.find((o) => !o.occupied) ?? options[0];
          setSelectedBedValue(firstFree.value);
          const parsed = parseBedSelection(firstFree.value);
          setDraft((d) => (d ? { ...d, roomId: parsed.roomId, preferredBed: parsed.preferredBed } : d));
        }
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setBedOptions([]);
      });

    return () => controller.abort();
  }, [draft?.checkInDate, draft?.checkOutDate, draft?.status, id, selectedBedValue]);

  const hasUnsavedChanges = useMemo(() => {
    if (!booking || !draft) return false;
    return (
      booking.leadGuestName !== draft.leadGuestName ||
      (booking.contactPhone ?? "") !== draft.contactPhone ||
      (booking.contactEmail ?? "") !== draft.contactEmail ||
      booking.checkInDate !== draft.checkInDate ||
      (booking.checkOutDate ?? "") !== draft.checkOutDate ||
      (primarySegment?.roomId ? String(primarySegment.roomId) : "") !== draft.roomId ||
      (primarySegment?.preferredBed ? String(primarySegment.preferredBed) : "") !== draft.preferredBed ||
      booking.bookingType !== draft.bookingType ||
      booking.status !== draft.status ||
      (primaryGuest?.dietaryRequirements ?? "") !== draft.dietaryRequirements ||
      (booking.notes ?? "") !== draft.notes
    );
  }, [booking, draft, primarySegment?.roomId, primarySegment?.preferredBed, primaryGuest?.dietaryRequirements]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  async function upsertPrimarySegment(next: BookingDraft) {
    if (!booking || next.status !== "confirmed") return;
    if (!next.roomId || !next.checkInDate || !next.checkOutDate) return;

    const roomId = Number(next.roomId);
    const preferredBed = next.preferredBed.trim() ? Number(next.preferredBed) : null;

    if (primarySegment) {
      await fetch(`/api/segments/${primarySegment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          preferredBed,
          startDate: next.checkInDate,
          endDate: next.checkOutDate,
          guestCount: 1,
        }),
      });
      return;
    }

    await fetch("/api/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: booking.id,
        roomId,
        startDate: next.checkInDate,
        endDate: next.checkOutDate,
        guestCount: 1,
        preferredBed,
      }),
    });
  }

  async function saveChanges(): Promise<boolean> {
    if (!draft) return true;
    setSaving(true);
    setError(null);

    if (draft.status === "confirmed" && !draft.roomId) {
      setSaving(false);
      setError("No available room for the selected date range.");
      return false;
    }

    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        leadGuestName: draft.leadGuestName,
        contactPhone: draft.contactPhone,
        contactEmail: draft.contactEmail,
        checkInDate: draft.checkInDate,
        checkOutDate: draft.checkOutDate || null,
        bookingType: draft.bookingType,
        status: draft.status,
        notes: draft.notes,
      }),
    });

    if (!res.ok) {
      setSaving(false);
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save booking changes.");
      return false;
    }

    await upsertPrimarySegment(draft);

    if (primaryGuest) {
      await fetch(`/api/booking-guests/${primaryGuest.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.leadGuestName,
          dietaryRequirements: draft.dietaryRequirements,
        }),
      });
    } else if (draft.dietaryRequirements.trim()) {
      await fetch("/api/booking-guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: Number(id),
          name: draft.leadGuestName,
          dietaryRequirements: draft.dietaryRequirements,
        }),
      });
    }

    setSaving(false);
    await load();
    return true;
  }

  async function saveAndExit() {
    const ok = await saveChanges();
    if (ok) router.push("/bookings");
  }

  async function backToBookings() {
    if (!hasUnsavedChanges) {
      router.push("/bookings");
      return;
    }
    const saveFirst = confirm("You have unsaved changes. Save before leaving?");
    if (saveFirst) {
      const ok = await saveChanges();
      if (ok) router.push("/bookings");
      return;
    }
    const abandon = confirm("Discard unsaved changes and return to bookings?");
    if (abandon) router.push("/bookings");
  }

  async function addMove(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const res = await fetch("/api/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId: Number(id),
        roomId: Number(newSegment.roomId),
        preferredBed: newSegment.preferredBed.trim() ? Number(newSegment.preferredBed) : null,
        startDate: newSegment.startDate,
        endDate: newSegment.endDate,
        guestCount: 1,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not add room move.");
      return;
    }

    load();
  }

  async function updateSegment(segmentId: number, patch: SegmentPatch) {
    await fetch(`/api/segments/${segmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    load();
  }

  async function deleteSegment(segmentId: number) {
    await fetch(`/api/segments/${segmentId}`, { method: "DELETE" });
    load();
  }

  async function deleteBooking() {
    if (!confirm("Delete this booking? This marks it as cancelled.")) return;
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

  const nights = nightsBetween(draft.checkInDate, draft.checkOutDate || null);
  const canPlanRoomMoves = draft.status === "confirmed";

  return (
    <div className="tr-shell" style={{ maxWidth: 1080 }}>
      <div className="tr-page-header">
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <h1 className="tr-page-title" style={{ margin: 0 }}>{booking.leadGuestName}</h1>
          <StatusBadge status={draft.status} />
        </div>
        <a href="/bookings" className="tr-back-link" onClick={(e) => { e.preventDefault(); backToBookings(); }}>
          ← Back to Bookings
        </a>
      </div>

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="tr-card">
        <div className="tr-form-grid">
          <section className="tr-form-section">
            <h2 className="tr-section-title">Stay Details</h2>

            <div className="tr-inline-grid">
              <Field label="Check-in">
                <input
                  type="date"
                  value={draft.checkInDate}
                  onChange={(e) => setDraft({ ...draft, checkInDate: e.target.value })}
                />
              </Field>
              <Field label="Check-out">
                <input
                  type="date"
                  value={draft.checkOutDate}
                  onChange={(e) => setDraft({ ...draft, checkOutDate: e.target.value })}
                />
              </Field>
            </div>

            <p className="tr-muted" style={{ marginTop: -2, marginBottom: 10 }}>
              {draft.checkOutDate
                ? `${nights} ${nights === 1 ? "night" : "nights"} (${formatDateUk(draft.checkInDate)} to ${formatDateUk(draft.checkOutDate)})`
                : "Open-ended stay"}
            </p>

            <Field label="Bed assignment">
              <select
                value={selectedBedValue}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  const next = bedOptions.find((o) => o.value === nextValue);
                  if (!next) {
                    setSelectedBedValue("");
                    setDraft((d) => (d ? { ...d, roomId: "", preferredBed: "" } : d));
                    return;
                  }
                  if (next.occupied && next.warning) {
                    const proceed = confirm(`Warning: ${next.warning}\n\nSelect this bed anyway?`);
                    if (!proceed) return;
                  }
                  setSelectedBedValue(nextValue);
                  const parsed = parseBedSelection(nextValue);
                  setDraft((d) => (d ? { ...d, roomId: parsed.roomId, preferredBed: parsed.preferredBed } : d));
                }}
                disabled={!canPlanRoomMoves}
              >
                <option value="">- select bed -</option>
                {bedOptions.map((opt) => (
                  <option key={opt.value} value={opt.value} style={{ color: opt.occupied ? "#777" : "#2f3b2e" }}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Booking type">
              <select
                value={draft.bookingType}
                onChange={(e) => setDraft({ ...draft, bookingType: e.target.value })}
              >
                <option value="guest">Guest</option>
                <option value="resident">Resident</option>
                <option value="guardian">Guardian</option>
                <option value="worker">Worker</option>
              </select>
            </Field>
          </section>

          <section className="tr-form-section">
            <h2 className="tr-section-title">Guest Information</h2>

            <Field label="Name">
              <input
                value={draft.leadGuestName}
                onChange={(e) => setDraft({ ...draft, leadGuestName: e.target.value })}
              />
            </Field>

            <div className="tr-inline-grid">
              <Field label="Contact phone">
                <input
                  type="tel"
                  value={draft.contactPhone}
                  onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })}
                />
              </Field>
              <Field label="Contact email">
                <input
                  type="email"
                  value={draft.contactEmail}
                  onChange={(e) => setDraft({ ...draft, contactEmail: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Status">
              <div className="tr-status-toggle" role="group" aria-label="Booking status">
                {[
                  { value: "draft", label: "Provisional" },
                  { value: "confirmed", label: "Confirmed" },
                  { value: "cancelled", label: "Cancelled" },
                ].map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={`tr-chip${draft.status === s.value ? " tr-chip-active" : ""}`}
                    onClick={() => setDraft({ ...draft, status: s.value as Booking["status"] })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>
          </section>
        </div>

        <section className="tr-form-section" style={{ marginTop: 12 }}>
          <h2 className="tr-section-title">Dietary and Notes</h2>

          <Field label="Dietary requirements">
            <DietaryTagInput
              tags={splitDietaryTags(draft.dietaryRequirements)}
              onChange={(tags) => setDraft({ ...draft, dietaryRequirements: joinDietaryTags(tags) })}
              suggestions={dietaryTags}
              placeholder="e.g. Gluten-Free"
            />
          </Field>

          <Field label="Notes">
            <textarea
              rows={4}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </Field>
        </section>
      </div>

      <div className="tr-card">
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Room moves (optional)</summary>
          {!canPlanRoomMoves ? (
            <p className="tr-muted" style={{ marginTop: 10 }}>
              Room moves are available only for confirmed bookings.
            </p>
          ) : (
            <>
              <div className="tr-table-wrap" style={{ marginTop: 10, marginBottom: 12 }}>
                <table className="tr-table">
                  <thead>
                    <tr>
                      <th>Room</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Bed</th>
                      <th className="tr-col-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSegments.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="tr-muted">No room segments yet. Add a move below.</td>
                      </tr>
                    ) : (
                      sortedSegments.map((s) => (
                        <tr key={s.id}>
                          <td>{rooms.find((r) => r.id === s.roomId)?.name ?? s.roomId}</td>
                          <td>{formatDateUk(s.startDate)}</td>
                          <td>
                            <input
                              type="date"
                              defaultValue={s.endDate}
                              style={{ width: 150 }}
                              onBlur={(e) => e.target.value !== s.endDate && updateSegment(s.id, { endDate: e.target.value })}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={1}
                              defaultValue={s.preferredBed ? String(s.preferredBed) : ""}
                              style={{ width: 100 }}
                              onBlur={(e) => {
                                const next = e.target.value.trim() ? Number(e.target.value) : null;
                                if ((s.preferredBed ?? null) !== next) updateSegment(s.id, { preferredBed: next });
                              }}
                            />
                          </td>
                          <td className="tr-col-actions">
                            <button type="button" onClick={() => deleteSegment(s.id)}>Remove</button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <form onSubmit={addMove}>
                <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 14 }}>Add Move</h3>
                <div className="tr-inline-grid">
                  <Field label="Room">
                    <select required value={newSegment.roomId} onChange={(e) => setNewSegment({ ...newSegment, roomId: e.target.value })}>
                      <option value="">- select -</option>
                      {rooms.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Bed (optional)">
                    <input
                      type="number"
                      min={1}
                      value={newSegment.preferredBed}
                      onChange={(e) => setNewSegment({ ...newSegment, preferredBed: e.target.value })}
                    />
                  </Field>

                  <Field label="Start">
                    <input
                      type="date"
                      required
                      value={newSegment.startDate}
                      onChange={(e) => setNewSegment({ ...newSegment, startDate: e.target.value })}
                    />
                  </Field>

                  <Field label="End">
                    <input
                      type="date"
                      required
                      value={newSegment.endDate}
                      onChange={(e) => setNewSegment({ ...newSegment, endDate: e.target.value })}
                    />
                  </Field>
                </div>

                <div className="tr-form-actions" style={{ justifyContent: "flex-end", marginTop: 6 }}>
                  <button type="submit" className="primary">Add Move</button>
                </div>
              </form>
            </>
          )}
        </details>
      </div>

      <div className="tr-card">
        <h2 className="tr-section-title" style={{ marginBottom: 8 }}>Delete booking</h2>
        <p className="tr-muted" style={{ marginTop: 0 }}>
          This marks the booking as cancelled and keeps it for historical records.
        </p>
        <button type="button" className="tr-danger" onClick={deleteBooking}>Delete Booking</button>
      </div>

      <div className="tr-sticky-actions">
        <button type="button" onClick={backToBookings}>Back</button>
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

function StatusBadge({ status }: { status: Booking["status"] }) {
  const className =
    status === "confirmed"
      ? "tr-badge tr-badge-ok"
      : status === "cancelled"
        ? "tr-badge tr-badge-warn"
        : "tr-badge";

  const label = status === "draft" ? "Provisional" : status[0].toUpperCase() + status.slice(1);
  return <span className={className}>{label}</span>;
}
