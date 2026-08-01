import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(bookings).orderBy(desc(bookings.arrivalDate));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const guestName = String(body.guestName ?? "").trim();
  const arrivalDate = String(body.arrivalDate ?? "");
  const departureDate = String(body.departureDate ?? "");
  const groupId = body.groupId ? String(body.groupId).trim() || null : null;
  const bedId = body.bedId ? Number(body.bedId) : null;
  const dietariesTags = Array.isArray(body.dietariesTags) ? body.dietariesTags : null;

  if (!guestName) return NextResponse.json({ error: "Guest name is required" }, { status: 400 });
  if (!arrivalDate) return NextResponse.json({ error: "Arrival date is required" }, { status: 400 });
  if (!departureDate) return NextResponse.json({ error: "Departure date is required" }, { status: 400 });
  if (departureDate <= arrivalDate) {
    return NextResponse.json({ error: "Departure date must be after arrival date" }, { status: 400 });
  }

  const [booking] = await db
    .insert(bookings)
    .values({ guestName, arrivalDate, departureDate, groupId, bedId, dietariesTags })
    .returning();

  return NextResponse.json(booking, { status: 201 });
}
