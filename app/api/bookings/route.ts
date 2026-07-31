import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bookings, bookingGuests, stayRoomSegments } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { desc } from "drizzle-orm";
import { isPlausibleEmail, normaliseOptional, parseGuestList } from "@/lib/guests";
import { checkRoomAvailabilityForRange } from "@/lib/room-availability";

export const dynamic = "force-dynamic";

const VALID_BOOKING_TYPES = ["guest", "resident", "guardian", "worker"] as const;
const VALID_STATUS = ["draft", "confirmed", "cancelled"] as const;

export async function GET() {
  const rows = await db.query.bookings.findMany({
    with: { segments: true, guests: true },
    orderBy: [desc(bookings.checkInDate)],
  });
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const leadGuestName = String(body.leadGuestName ?? "").trim();
  const guestCount = Number(body.guestCount ?? 1);
  const checkInDate = String(body.checkInDate ?? "");
  const checkOutDate = body.checkOutDate ? String(body.checkOutDate) : null;
  const bookingType = VALID_BOOKING_TYPES.includes(body.bookingType) ? body.bookingType : "guest";
  const status = VALID_STATUS.includes(body.status) ? body.status : "draft";
  const roomId = body.roomId ? Number(body.roomId) : null;

  if (!leadGuestName) return NextResponse.json({ error: "Lead guest name is required" }, { status: 400 });
  if (!checkInDate) return NextResponse.json({ error: "Check-in date is required" }, { status: 400 });
  if (!Number.isInteger(guestCount) || guestCount < 1) {
    return NextResponse.json({ error: "Guest count must be a positive integer" }, { status: 400 });
  }
  if (checkOutDate && checkOutDate <= checkInDate) {
    return NextResponse.json({ error: "Check-out date must be after check-in date" }, { status: 400 });
  }

  const contactPhone = normaliseOptional(body.contactPhone);
  const contactEmail = normaliseOptional(body.contactEmail);
  if (contactEmail && !isPlausibleEmail(contactEmail)) {
    return NextResponse.json({ error: "Contact email doesn't look valid" }, { status: 400 });
  }

  // Named people are optional and independent of guestCount — see the comment
  // on the booking_guests table. Rows with no name at all are dropped so an
  // empty "add another person" row in the form isn't an error.
  const guests = parseGuestList(body.guests);
  if (guests.some((g) => g.name.length > 200)) {
    return NextResponse.json({ error: "Person name is too long" }, { status: 400 });
  }
  const badEmail = guests.find((g) => g.email && !isPlausibleEmail(g.email));
  if (badEmail) {
    return NextResponse.json(
      { error: `Email for ${badEmail.name} doesn't look valid` },
      { status: 400 }
    );
  }

  if (status === "confirmed" && roomId && checkOutDate) {
    const availability = await checkRoomAvailabilityForRange({
      roomId,
      startDate: checkInDate,
      endDate: checkOutDate,
      guestCount,
    });
    if (!availability.ok) {
      return NextResponse.json(
        { error: availability.message ?? "Room is unavailable for part of this stay." },
        { status: 409 }
      );
    }
  }

  const [booking] = await db
    .insert(bookings)
    .values({
      leadGuestName,
      contactPhone,
      contactEmail,
      guestCount,
      checkInDate,
      checkOutDate,
      bookingType,
      countsTowardCapacity: true,
      countsTowardMeals: true,
      status,
      notes: body.notes ?? null,
      createdBy: user.id,
    })
    .returning();

  let createdGuests: (typeof bookingGuests.$inferSelect)[] = [];
  if (guests.length > 0) {
    createdGuests = await db
      .insert(bookingGuests)
      .values(
        guests.map((g) => ({
          bookingId: booking.id,
          name: g.name,
          dietaryRequirements: g.dietaryRequirements,
          phone: g.phone,
          email: g.email,
        }))
      )
      .returning();
  }

  // Convenience: if a roomId was supplied on creation, create the initial
  // stay_room_segment spanning the full booking so the common case (one
  // room, no mid-stay move) takes a single form submission. Room moves are
  // then just "end this segment early + add a new one" via /api/segments.
  if (status === "confirmed" && roomId && checkOutDate) {
    await db.insert(stayRoomSegments).values({
      bookingId: booking.id,
      roomId,
      startDate: checkInDate,
      endDate: checkOutDate,
      guestCount,
    });
  }

  return NextResponse.json({ ...booking, guests: createdGuests }, { status: 201 });
}
