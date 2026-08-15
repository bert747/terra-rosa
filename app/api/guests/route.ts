import { NextRequest, NextResponse } from "next/server";
import { ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { guests } from "@/db/schema";

export const dynamic = "force-dynamic";

// Search-only — guest profiles are only ever created via a booking's own
// "save as a new profile" action (see resolveGuestLink), never a standalone
// form, so there's no POST here. Matches first/last/preferred name,
// case-insensitive substring, same fields the Bookings page's own search
// matches on.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json([]);

  const pattern = `%${q}%`;
  const rows = await db
    .select()
    .from(guests)
    .where(or(ilike(guests.firstName, pattern), ilike(guests.lastName, pattern), ilike(guests.preferredName, pattern)))
    .limit(20);

  return NextResponse.json(rows);
}
