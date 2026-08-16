import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, guests } from "@/db/schema";

export interface GuestProfileFields {
  firstName: string;
  lastName: string;
  preferredName: string | null;
  dietariesTags: unknown;
}

/**
 * Pushes `fields` onto every booking currently linked to `guestId` — the
 * shared bit of "editing a guest's name/dietary keeps every booking that
 * references them current" (see resolveGuestLink below), also used by
 * `PATCH /api/guests/[id]` so editing a profile directly from the /guests
 * page has the exact same effect as editing it via a linked booking.
 * Deliberately does NOT touch email/phone — those are pure contact info,
 * never mirrored onto bookings.* (see the guests table's own schema
 * comment), so there's nothing of theirs for a booking row to keep in sync.
 */
export async function syncGuestFieldsToBookings(guestId: number, fields: GuestProfileFields): Promise<void> {
  await db
    .update(bookings)
    .set({ ...fields, guestName: `${fields.firstName} ${fields.lastName}`.trim() })
    .where(eq(bookings.guestId, guestId));
}

/**
 * Resolves what a booking POST/PATCH's `guestId`/`createGuestProfile` body
 * fields mean for the guests table, and returns what `bookings.guestId`
 * should become. A booking form sends at most one of:
 *
 *   - `guestId: <number>`   Link to that existing guest AND overwrite its
 *     master record with `fields` — this is the "editing dietary on a
 *     booking that's linked to a guest profile updates the profile too, so
 *     it's right next time" behaviour, confirmed as the intended design
 *     (not just a snapshot copy).
 *   - `guestId: null`       Unlink. Does not touch/delete the guest row —
 *     other bookings may still be linked to it.
 *   - `createGuestProfile: true`   Insert a brand-new guest from `fields`
 *     and link to it — how a guest profile gets created in the first
 *     place, always an explicit staff action from the booking form, never
 *     automatic/retroactive (see the guests table's own schema comment).
 *   - neither present       No change — returns `undefined` so the caller
 *     leaves the booking's existing guestId exactly as it was.
 */
export async function resolveGuestLink(
  body: { guestId?: number | null; createGuestProfile?: boolean },
  fields: GuestProfileFields
): Promise<number | null | undefined> {
  if (body.createGuestProfile === true) {
    const [created] = await db.insert(guests).values(fields).returning({ id: guests.id });
    return created.id;
  }
  if (body.guestId === null) return null;
  if (typeof body.guestId === "number") {
    await db.update(guests).set(fields).where(eq(guests.id, body.guestId));
    // The whole point of a shared profile: this update needs to reach
    // every OTHER booking already linked to the same guest too, not just
    // the one being saved right now (that one gets `fields` written onto
    // its own row separately by the caller, alongside whatever ELSE it's
    // changing this save — dates, bed, etc.). Without this, editing
    // dietary on Mary's third booking would leave her first and second
    // showing stale info until each was independently re-linked.
    await syncGuestFieldsToBookings(body.guestId, fields);
    return body.guestId;
  }
  return undefined;
}
