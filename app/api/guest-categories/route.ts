import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { guestCategories } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

// Returns every category, active and inactive — a booking made while a
// category was active can still reference an since-deactivated one (see
// guestCategories' own schema comment), so callers that need to render an
// existing booking's colour/label must see the full list. Callers that are
// only offering a picker for a NEW/changed assignment (the booking form,
// the settings card's own "add" affordance) filter to `active` client-side.
export async function GET() {
  const rows = await db.select().from(guestCategories).orderBy(asc(guestCategories.rank), asc(guestCategories.id));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const colour = String(body.colour ?? "").trim();
  if (!name) return NextResponse.json({ error: "Category name is required" }, { status: 400 });
  if (!colour) return NextResponse.json({ error: "Colour is required" }, { status: 400 });

  // New categories default to the back of the order — staff drag it into
  // place afterward rather than guessing a rank up front.
  const rows = await db.select().from(guestCategories);
  const maxRank = rows.reduce((max, r) => Math.max(max, r.rank), -1);

  const [category] = await db.insert(guestCategories).values({ name, colour, rank: maxRank + 1 }).returning();
  await logChange({ category: "layout", action: "Created guest category", summary: `Created guest category "${name}"` });
  return NextResponse.json(category, { status: 201 });
}
