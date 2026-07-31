import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, ne, or, gte } from "drizzle-orm";
import { db } from "@/db";
import { bookingGuests, bookings } from "@/db/schema";
import { STANDARD_DIETARY_TAGS, splitDietaryTags } from "@/lib/dietary-tags";

export const dynamic = "force-dynamic";

// Suggestion list for the dietary tag picker: the curated standard tags,
// plus whatever custom tags are still in live use. Scoped to active/future
// bookings only, so a one-off tag from a booking that finished last year
// doesn't linger in every guest's autocomplete forever.
export async function GET() {
  const today = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({ dietaryRequirements: bookingGuests.dietaryRequirements })
    .from(bookingGuests)
    .innerJoin(bookings, eq(bookingGuests.bookingId, bookings.id))
    .where(
      and(
        isNotNull(bookingGuests.dietaryRequirements),
        ne(bookings.status, "cancelled"),
        or(isNull(bookings.checkOutDate), gte(bookings.checkOutDate, today))
      )
    );

  // Keyed by lowercase so a custom tag matching a standard one in different
  // casing (or repeated across bookings) doesn't produce duplicate pills.
  const tagsByKey = new Map<string, string>();
  for (const tag of STANDARD_DIETARY_TAGS) tagsByKey.set(tag.toLowerCase(), tag);
  for (const row of rows) {
    for (const tag of splitDietaryTags(row.dietaryRequirements ?? "")) {
      const key = tag.toLowerCase();
      if (!tagsByKey.has(key)) tagsByKey.set(key, tag);
    }
  }

  return NextResponse.json({
    tags: Array.from(tagsByKey.values()).sort((a, b) => a.localeCompare(b)),
  });
}
