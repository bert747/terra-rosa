import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dailyMealNotes } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date query param is required" }, { status: 400 });
  const rows = await db.select().from(dailyMealNotes).where(eq(dailyMealNotes.date, date)).limit(1);
  return NextResponse.json(rows[0] ?? null);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const date = String(body.date ?? "");
  if (!date) return NextResponse.json({ error: "date is required" }, { status: 400 });

  const existing = await db.select().from(dailyMealNotes).where(eq(dailyMealNotes.date, date)).limit(1);

  if (existing.length > 0) {
    const [row] = await db
      .update(dailyMealNotes)
      .set({
        dietaryAdjustmentCount: 0,
        notes: body.notes ?? existing[0].notes,
      })
      .where(eq(dailyMealNotes.date, date))
      .returning();
    return NextResponse.json(row);
  }

  const [row] = await db
    .insert(dailyMealNotes)
    .values({
      date,
      dietaryAdjustmentCount: 0,
      notes: body.notes ?? null,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
