import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { computeBookingRows, loadBookingRowContext } from "@/lib/booking-rows";

export const dynamic = "force-dynamic";

// Search-only endpoint: unlike GET /api/bookings (unlimited, but the
// Bookings page itself only ever renders its own most-recent-200 slice),
// this one exists specifically so the search box can reach bookings OUTSIDE
// that default 200 — i.e. genuinely search the guest's WHOLE history, not
// just whatever the page happened to load. Matches first name, surname, or
// preferred name (case-insensitive, substring) — same fields as the client-
// side filter used when there's no query yet to hit this endpoint for.
const MAX_RESULTS = 200;

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  if (!q) return NextResponse.json([]);

  const [rows, ctx] = await Promise.all([
    db.select().from(bookings).orderBy(desc(bookings.arrivalDate)),
    loadBookingRowContext(),
  ]);

  const matches = rows.filter(
    (b) =>
      b.firstName.toLowerCase().includes(q) ||
      b.lastName.toLowerCase().includes(q) ||
      (b.preferredName?.toLowerCase().includes(q) ?? false)
  );

  // computeBookingRows resolves "shares with" groups from whatever set it's
  // given — running it over just the matches (not every booking) means a
  // match's mate who DIDN'T themselves match the search won't show up in
  // "shares with" here. Good enough for a search result list (the mate's
  // own row is one search away), not worth the cost of loading + grouping
  // every booking just to fully resolve this one column.
  return NextResponse.json(computeBookingRows(matches, ctx).slice(0, MAX_RESULTS));
}
