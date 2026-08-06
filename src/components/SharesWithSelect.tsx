"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDateUk } from "@/lib/dates";

interface BookingOption {
  id: number;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
}

export type SharesWithMode = "room" | "bed";

interface SharesWithSelectProps {
  bookingId: number | null;
  mode: SharesWithMode;
  onChange: (bookingId: number | null, mode: SharesWithMode) => void;
  arrivalDate: string;
  departureDate: string;
  /** Exclude this booking itself from the candidate list (editing an existing booking). */
  excludeBookingId?: number;
}

/**
 * "Shares with" — one guest picker with a Same room / Same bed toggle over
 * the top. Same room writes linkedBookingId (a one-directional proximity
 * hint only — auto-allocate tries that room first, no guaranteed adjacency).
 * Same bed writes sharesBedWithBookingId (a real symmetric pairing — on
 * save the server auto-assigns the partner's bed and joins the two beds
 * into a double, see /api/bookings/[id]/share-bed), which also implies
 * same room, so the toggle is a strict room ⊂ bed relationship, not two
 * independent settings.
 */
export default function SharesWithSelect({
  bookingId,
  mode,
  onChange,
  arrivalDate,
  departureDate,
  excludeBookingId,
}: SharesWithSelectProps) {
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

  const selected = all.find((b) => b.id === bookingId) ?? null;

  return (
    <div>
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
            data-tooltip="Clear"
            onClick={() => {
              onChange(null, mode);
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
                  onChange(c.id, mode);
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
      <div className="tr-toggle-group" role="group" aria-label="Shares with mode" style={{ marginTop: 6 }}>
        <button
          type="button"
          className={mode === "room" ? "tr-toggle active" : "tr-toggle"}
          onClick={() => onChange(bookingId, "room")}
        >
          Same room
        </button>
        <button
          type="button"
          className={mode === "bed" ? "tr-toggle active" : "tr-toggle"}
          onClick={() => onChange(bookingId, "bed")}
        >
          Same bed
        </button>
      </div>
    </div>
  );
}
