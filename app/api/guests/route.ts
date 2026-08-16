import { NextRequest, NextResponse } from "next/server";
import { asc, ilike, or } from "drizzle-orm";
import { db } from "@/db";
import { guests } from "@/db/schema";

export const dynamic = "force-dynamic";

// No `q` — the /guests management page's own full list, every profile,
// name-sorted. With `q` — the booking form's autocomplete (or the /guests
// page's own search box), matching first/last/preferred name,
// case-insensitive substring, capped at 20 since it's a live-typing lookup.
// Creating a guest is only ever done via a booking's own "new profile" flow
// (see resolveGuestLink), never a standalone POST here.
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  if (!q) {
    const rows = await db.select().from(guests).orderBy(asc(guests.lastName), asc(guests.firstName));
    return NextResponse.json(rows);
  }

  const pattern = `%${q}%`;
  const rows = await db
    .select()
    .from(guests)
    .where(or(ilike(guests.firstName, pattern), ilike(guests.lastName, pattern), ilike(guests.preferredName, pattern)))
    .orderBy(asc(guests.lastName), asc(guests.firstName))
    .limit(20);

  return NextResponse.json(rows);
}
