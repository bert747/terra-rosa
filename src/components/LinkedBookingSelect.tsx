"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateUk } from "@/lib/dates";

interface BookingOption {
  id: number;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
}

interface LinkedBookingSelectProps {
  value: number | null;
  onChange: (id: number | null) => void;
  arrivalDate: string;
  departureDate: string;
  /** Exclude this booking itself from the candidate list (editing an existing booking). */
  excludeBookingId?: number;
}

/**
 * "Sleeps near / Linked with" — a searchable dropdown of OTHER guests whose
 * own booking overlaps the selected arrival/departure range (exclusive-end
 * date overlap, same rule the grid itself uses for a bed's occupied nights).
 * Fetches the full bookings list once and filters client-side rather than a
 * dedicated overlap endpoint — this app's booking volume (a single hostel)
 * never gets large enough for that to matter.
 */
export default function LinkedBookingSelect({ value, onChange, arrivalDate, departureDate, excludeBookingId }: LinkedBookingSelectProps) {
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
