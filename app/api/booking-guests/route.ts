import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingGuests } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { isPlausibleEmail, normaliseOptional } from "@/lib/guests";

export const dynamic = "force-dynamic";

// People named on a booking, with their dietary requirements. Creation of a
// whole list at once happens inline in POST /api/bookings; this route is for
// adding/editing people on a booking that already exists.

export async function GET(req: NextRequest) {
  const bookingId = Number(req.nextUrl.searchParams.get("bookingId"));
  if (!Number.isInteger(bookingId) || bookingId < 1) {
    return NextResponse.json({ error: "bookingId is required" }, { status: 400 });
  }
  const rows = await db
    .select()
    .from(bookingGuests)
    .where(eq(bookingGuests.bookingId, bookingId))
    .orderBy(asc(bookingGuests.id));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bookingId = Number(body.bookingId);
  const name = String(body.name ?? "").trim();
  const dietaryRequirements = normaliseOptional(body.dietaryRequirements);
  const phone = normaliseOptional(body.phone);
  const email = normaliseOptional(body.email);
  const preferredBed = body.preferredBed ? Number(body.preferredBed) : null;

  if (!Number.isInteger(bookingId) || bookingId < 1) {
    return NextResponse.json({ error: "bookingId is required" }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: "Person name is required" }, { status: 400 });
  if (name.length > 200) return NextResponse.json({ error: "Person name is too long" }, { status: 400 });
  if (email && !isPlausibleEmail(email)) {
    return NextResponse.json({ error: "Email doesn't look valid" }, { status: 400 });
  }

  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  const [row] = await db
    .insert(bookingGuests)
    .values({
      bookingId,
      name,
      preferredBed: preferredBed && preferredBed > 0 ? preferredBed : null,
      dietaryRequirements,
      phone,
      email,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
