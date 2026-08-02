import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dailyMealNotes } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(dailyMealNotes);
  return NextResponse.json(rows);
}

// Upsert-by-date: the Kitchen Prep Matrix's "Notes" button always edits
// whatever's there for that date, never creates a duplicate row for a date
// that already has one (see daily_meal_notes_date_idx).
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const date = String(body.date ?? "");
  const notes = String(body.notes ?? "").trim() || null;
  if (!date) return NextResponse.json({ error: "date is required" }, { status: 400 });

  const [row] = await db
    .insert(dailyMealNotes)
    .values({ date, notes })
    .onConflictDoUpdate({ target: dailyMealNotes.date, set: { notes } })
    .returning();

  return NextResponse.json(row);
}
