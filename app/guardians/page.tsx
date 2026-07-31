"use client";

import { useEffect, useMemo, useState } from "react";
import GuardianOccupancyPopup from "@/components/GuardianOccupancyPopup";

interface BookingRow {
  id: number;
  leadGuestName: string;
  checkInDate: string;
  checkOutDate: string | null;
  bookingType: string;
  status: string;
}

interface PresenceOverride {
  id: number;
  bookingId: number;
  startDate: string;
  endDate: string | null;
  isOccupied: boolean;
  note: string | null;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function endText(endDate: string | null) {
  return endDate ?? "No end date";
}

export default function GuardiansPage() {
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [overridesByBooking, setOverridesByBooking] = useState<Record<number, PresenceOverride[]>>({});
  const [popup, setPopup] = useState<{ bookingId: number; guardianName: string; date: string } | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const rows = await fetch("/api/bookings").then((res) => res.json());
    const guardianRows = rows.filter(
      (row: BookingRow) => row.bookingType === "guardian" && row.status !== "cancelled"
    );
    setBookings(guardianRows);

    if (guardianRows.length > 0) {
      const ids = guardianRows.map((b: BookingRow) => b.id).join(",");
      const overrides = await fetch(`/api/guardian-presence?bookingIds=${ids}`).then((res) => res.json());
      const grouped: Record<number, PresenceOverride[]> = {};
      (overrides as PresenceOverride[]).forEach((ov) => {
        if (!grouped[ov.bookingId]) grouped[ov.bookingId] = [];
        grouped[ov.bookingId].push(ov);
      });
      setOverridesByBooking(grouped);
    } else {
      setOverridesByBooking({});
    }

    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  const guardianBookings = useMemo(() => bookings, [bookings]);

  function upcomingTrips(bookingId: number) {
    const today = todayISO();
    return (overridesByBooking[bookingId] ?? [])
      .filter((ov) => !ov.isOccupied)
      .filter((ov) => !ov.endDate || ov.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id - b.id);
  }

  return (
    <div className="tr-shell">
      <a href="/dashboard">← Back to dashboard</a>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>Guardians</h1>
      <p className="tr-muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 12 }}>
        Guardians are occupied by default. Use custom dates to mark ranges as free or occupied, including ongoing ranges with no end date.
      </p>

      {loading && <p className="tr-muted">Loading guardians...</p>}

      {!loading && guardianBookings.length === 0 && (
        <div className="tr-card">
          <p style={{ marginTop: 0 }}>No active guardian bookings were found.</p>
          <a href="/bookings/new">Create guardian booking</a>
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {guardianBookings.map((booking) => {
          const trips = upcomingTrips(booking.id);
          return (
            <div key={booking.id} className="tr-card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div>
                  <strong>{booking.leadGuestName}</strong>
                  <div className="tr-muted" style={{ fontSize: 12 }}>
                    Booking: {booking.checkInDate} → {booking.checkOutDate ?? "No end date"}
                  </div>
                </div>
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    setPopup({
                      bookingId: booking.id,
                      guardianName: booking.leadGuestName,
                      date: todayISO(),
                    })
                  }
                >
                  Add custom dates
                </button>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Next planned trips</div>
                {trips.length === 0 ? (
                  <p className="tr-muted" style={{ margin: 0 }}>No trips currently planned.</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {trips.slice(0, 6).map((trip) => (
                      <li key={`${booking.id}-${trip.id}`}>
                        {trip.startDate} → {endText(trip.endDate)}
                        {trip.note ? <span className="tr-muted"> ({trip.note})</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <GuardianOccupancyPopup
        open={popup !== null}
        bookingId={popup?.bookingId ?? null}
        guardianName={popup?.guardianName ?? ""}
        initialDate={popup?.date ?? todayISO()}
        onClose={() => setPopup(null)}
        onSaved={load}
      />
    </div>
  );
}
