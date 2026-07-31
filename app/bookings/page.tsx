import { db } from "@/db";
import { desc, inArray } from "drizzle-orm";
import { bookings } from "@/db/schema";
import { formatDateUk } from "@/lib/dates";
import BookingsStatusFilter from "@/components/BookingsStatusFilter";

export const dynamic = "force-dynamic";

const STATUS_OPTIONS = ["draft", "confirmed", "cancelled"] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];

function isStatus(value: string | undefined): value is StatusOption {
  return !!value && STATUS_OPTIONS.includes(value as StatusOption);
}

function normalizeStatuses(value: string | string[] | undefined): StatusOption[] {
  const values = Array.isArray(value) ? value : value?.split(",") ?? [];
  return values.map((item) => item.trim()).filter((item): item is StatusOption => isStatus(item));
}

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const params = await searchParams;
  const selectedStatuses = normalizeStatuses(params.status);
  const effectiveStatuses = selectedStatuses.length === 0 ? (["draft", "confirmed"] as StatusOption[]) : selectedStatuses;

  const rows = await db.query.bookings.findMany({
    with: { segments: { with: { room: true } }, guests: true },
    where: effectiveStatuses.length === 0 ? undefined : inArray(bookings.status, effectiveStatuses),
    orderBy: [desc(bookings.checkInDate)],
    limit: 200,
  });

  return (
    <div>
      <div className="tr-shell">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>Bookings</h1>
          <span style={{ flex: 1 }} />
          <BookingsStatusFilter selectedStatuses={effectiveStatuses} />
          <a href="/bookings/new"><button className="primary">New booking</button></a>
        </div>

        <div className="tr-card" style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Guest</th>
                <th>Type</th>
                <th>Check-in</th>
                <th>Check-out</th>
                <th>Guests</th>
                <th>Room(s)</th>
                <th>Dietary</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="tr-row-link">
                  <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.leadGuestName}</a></td>
                  <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.bookingType}</a></td>
                  <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{formatDateUk(b.checkInDate)}</a></td>
                  <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.checkOutDate ? formatDateUk(b.checkOutDate) : "-"}</a></td>
                  <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.guestCount}</a></td>
                  <td><a className="tr-cell-link" href={`/bookings/${b.id}`}>{b.segments.map((s: any) => s.room?.name).filter(Boolean).join(", ") || "—"}</a></td>
                  <td
                    title={b.guests
                      .filter((g) => g.dietaryRequirements?.trim())
                      .map((g) => `${g.name}: ${g.dietaryRequirements}`)
                      .join("\n")}
                  >
                    <a className="tr-cell-link" href={`/bookings/${b.id}`}>{(() => {
                      const withDiet = b.guests.filter((g) => g.dietaryRequirements?.trim()).length;
                      return withDiet > 0 ? `${withDiet} ⚑` : "—";
                    })()}</a>
                  </td>
                  <td>
                    <a className="tr-cell-link" href={`/bookings/${b.id}`}>
                      <span
                        className={`tr-badge ${
                          b.status === "cancelled"
                            ? "tr-badge-warn"
                            : b.status === "confirmed"
                              ? "tr-badge-ok"
                              : ""
                        }`}
                      >
                        {b.status}
                      </span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
