import { and, eq, gt, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingGuests } from "@/db/schema";
import type { ISODate } from "@/lib/occupancy";

// ---------------------------------------------------------------------------
// Named people on a booking, and their dietary requirements.
//
// booking_guests is deliberately decoupled from occupancy: bookings.guest_count
// stays the authoritative headcount for every number on the grid, dashboard and
// meals page. This table is a place to record who the people are and what they
// can/can't eat, for however many of them are actually known.
// ---------------------------------------------------------------------------

export interface GuestInput {
  name: string;
  dietaryRequirements: string | null;
  phone: string | null;
  email: string | null;
}

export function splitDietaryTags(text: string): string[] {
  return text
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normaliseDietaryTag(tag: string): string {
  return tag.trim().toUpperCase();
}

/** Trim a free-text field, treating whitespace-only as "not provided". */
export function normaliseOptional(raw: unknown): string | null {
  return String(raw ?? "").trim() || null;
}

/**
 * Deliberately lenient: this catches fat-fingered entries like a missing "@"
 * without rejecting the unusual-but-valid addresses a stricter regex would.
 * These are internal records, so a false rejection costs more than a typo.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Normalise a `guests` array off a request body: trims strings, drops rows
 * with no name (an untouched blank row in the form), and coerces empty
 * optional fields to null.
 */
export function parseGuestList(raw: unknown): GuestInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g) => {
      const row = (g ?? {}) as Record<string, unknown>;
      return {
        name: String(row.name ?? "").trim(),
        dietaryRequirements: normaliseOptional(row.dietaryRequirements),
        phone: normaliseOptional(row.phone),
        email: normaliseOptional(row.email),
      };
    })
    .filter((g) => g.name !== "");
}

export interface DietaryEntry {
  bookingId: number;
  leadGuestName: string;
  bookingType: string;
  name: string;
  dietaryRequirements: string;
}

/**
 * Everyone with a recorded dietary requirement who is in-house on `date` —
 * i.e. on a confirmed booking that counts toward meals and whose stay covers
 * the date (check_in <= date < check_out; open-ended stays have no end).
 *
 * Deliberately keyed off the booking's own dates rather than stay segments, so
 * a booking that hasn't been assigned a room yet still shows up for the kitchen.
 */
export async function dietaryRequirementsForDate(date: ISODate): Promise<DietaryEntry[]> {
  const rows = await db
    .select({
      bookingId: bookings.id,
      leadGuestName: bookings.leadGuestName,
      bookingType: bookings.bookingType,
      name: bookingGuests.name,
      dietaryRequirements: bookingGuests.dietaryRequirements,
    })
    .from(bookingGuests)
    .innerJoin(bookings, eq(bookingGuests.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(bookings.countsTowardMeals, true),
        lte(bookings.checkInDate, date),
        or(isNull(bookings.checkOutDate), gt(bookings.checkOutDate, date))
      )
    );

  return rows
    .filter((r): r is typeof r & { dietaryRequirements: string } => Boolean(r.dietaryRequirements?.trim()))
    .sort((a, b) => a.leadGuestName.localeCompare(b.leadGuestName) || a.name.localeCompare(b.name));
}

/**
 * Same as dietaryRequirementsForDate but for a list of dates in one query,
 * returned as a date -> entries map. Used by the meals page, which shows ten
 * days at a time and would otherwise issue ten round trips.
 */
export async function dietaryRequirementsForDates(
  dates: ISODate[]
): Promise<Record<ISODate, DietaryEntry[]>> {
  const result: Record<ISODate, DietaryEntry[]> = {};
  for (const d of dates) result[d] = [];
  if (dates.length === 0) return result;

  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];

  const rows = await db
    .select({
      bookingId: bookings.id,
      leadGuestName: bookings.leadGuestName,
      bookingType: bookings.bookingType,
      checkInDate: bookings.checkInDate,
      checkOutDate: bookings.checkOutDate,
      name: bookingGuests.name,
      dietaryRequirements: bookingGuests.dietaryRequirements,
    })
    .from(bookingGuests)
    .innerJoin(bookings, eq(bookingGuests.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(bookings.countsTowardMeals, true),
        lte(bookings.checkInDate, windowEnd),
        or(isNull(bookings.checkOutDate), gte(bookings.checkOutDate, windowStart))
      )
    );

  for (const row of rows) {
    const diet = row.dietaryRequirements?.trim();
    if (!diet) continue;
    for (const d of dates) {
      if (row.checkInDate <= d && (row.checkOutDate === null || row.checkOutDate > d)) {
        result[d].push({
          bookingId: row.bookingId,
          leadGuestName: row.leadGuestName,
          bookingType: row.bookingType,
          name: row.name,
          dietaryRequirements: diet,
        });
      }
    }
  }

  for (const d of dates) {
    result[d].sort(
      (a, b) => a.leadGuestName.localeCompare(b.leadGuestName) || a.name.localeCompare(b.name)
    );
  }
  return result;
}
