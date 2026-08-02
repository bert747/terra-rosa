"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateUk } from "@/lib/dates";

interface BookingOption {
  id: number;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
}

interface ShareBedSelectProps {
  value: number | null;
  onChange: (id: number | null) => void;
  arrivalDate: string;
  departureDate: string;
  /** Exclude this booking itself from the candidate list (editing an existing booking). */
  excludeBookingId?: number;
}

/**
 * "Shares Bed With" — coupled allocation. Distinct from LinkedBookingSelect
 * ("Sleeps near", a one-directional proximity hint only): picking a partner
 * here is a real pairing — on save (see /api/bookings/[id]/share-bed) the
 * server auto-assigns the partner's bed (next Single down in the same room)
 * and joins the two beds into a "Couple Double", symmetrically linking both
 * bookings via sharesBedWithBookingId. Candidate list uses the same
 * date-overlap rule as LinkedBookingSelect.
 */
export default function ShareBedSelect({ value, onChange, arrivalDate, departureDate, excludeBookingId }: ShareBedSelectProps) {
  const [all, setAll] = useState<BookingOption[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/bookings")
      .then((r) => r.json())
      .then((rows: BookingOption[]) => setAll(rows))
      .catch(() => {});
  }, []);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  const candidates = useMemo(() => {
    if (!arrivalDate || !departureDate) return [];
    return all.filter(
      (b) => b.id !== excludeBookingId && b.arrivalDate < departureDate && b.departureDate > arrivalDate
    );
  }, [all, arrivalDate, departureDate, excludeBookingId]);

  const filtered = useMemo(
    () => candidates.filter((c) => c.guestName.toLowerCase().includes(query.toLowerCase())),
    [candidates, query]
  );

  const selected = all.find((b) => b.id === value) ?? null;

  return (
    <div ref={boxRef} className="tr-combobox">
      <input
        value={open ? query : (selected?.guestName ?? "")}
        placeholder={
          !arrivalDate || !departureDate
            ? "Pick dates first"
            : candidates.length === 0
              ? "No overlapping guests"
              : "Search guests…"
        }
        disabled={!arrivalDate || !departureDate}
        onFocus={() => setQuery("")}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
      />
      {selected && (
        <button
          type="button"
          className="tr-combobox-clear"
          title="Clear"
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          ×
        </button>
      )}
      {open && (
        <div className="tr-combobox-list">
          {filtered.length === 0 && <div className="tr-combobox-empty tr-muted">No matching guests</div>}
          {filtered.map((c) => (
            <div
              key={c.id}
              className="tr-combobox-option"
              onClick={() => {
                onChange(c.id);
                setOpen(false);
                setQuery("");
              }}
            >
              {c.guestName}{" "}
              <span className="tr-muted" style={{ fontSize: 11 }}>
                ({formatDateUk(c.arrivalDate)}–{formatDateUk(c.departureDate)})
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
