import { NextRequest, NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bookings, guardianPresenceOverrides } from "@/db/schema";
import { requireEditor, requireUser } from "@/lib/auth";
import {
  ensureValidPresenceWindow,
  normalizePresenceWindow,
} from "@/lib/guardian-presence";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const bookingIdRaw = req.nextUrl.searchParams.get("bookingId");
  const bookingIdsRaw = req.nextUrl.searchParams.get("bookingIds");

  if (bookingIdRaw) {
    const bookingId = Number(bookingIdRaw);
    if (!bookingId) return NextResponse.json({ error: "Invalid bookingId" }, { status: 400 });

    const rows = await db
      .select()
      .from(guardianPresenceOverrides)
      .where(eq(guardianPresenceOverrides.bookingId, bookingId))
      .orderBy(asc(guardianPresenceOverrides.startDate), asc(guardianPresenceOverrides.id));
    return NextResponse.json(rows);
  }

  if (bookingIdsRaw) {
    const bookingIds = bookingIdsRaw
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0);

    if (bookingIds.length === 0) return NextResponse.json([]);

    const rows = await db
      .select()
      .from(guardianPresenceOverrides)
      .where(inArray(guardianPresenceOverrides.bookingId, bookingIds))
      .orderBy(asc(guardianPresenceOverrides.bookingId), asc(guardianPresenceOverrides.startDate), asc(guardianPresenceOverrides.id));

    return NextResponse.json(rows);
  }

  return NextResponse.json({ error: "bookingId or bookingIds is required" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bookingId = Number(body.bookingId);
  const startDate = String(body.startDate ?? "");
  const endDateInput = body.endDate ? String(body.endDate) : null;
  const noEndDate = Boolean(body.noEndDate);
  const isOccupied = Boolean(body.isOccupied);
  const note = String(body.note ?? "").trim() || null;

  if (!bookingId) return NextResponse.json({ error: "bookingId is required" }, { status: 400 });

  const [booking] = await db
    .select({ id: bookings.id, bookingType: bookings.bookingType })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  if (booking.bookingType !== "guardian") {
    return NextResponse.json({ error: "Only guardian bookings support custom occupancy dates" }, { status: 400 });
  }

  const { endDate } = normalizePresenceWindow(startDate, endDateInput, noEndDate);
  const validationError = ensureValidPresenceWindow(startDate, endDate);
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 });

  const [created] = await db
    .insert(guardianPresenceOverrides)
    .values({
      bookingId,
      startDate,
      endDate,
      isOccupied,
      note,
    })
    .returning();

  return NextResponse.json(created, { status: 201 });
}
