import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { and, eq, gt, isNull, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

function coversDate(startDate: string, endDate: string | null, date: string): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

// Ends whichever join segment covers `atDate` for this pair of beds — used
// by the grid's right-click "Split into Singles" action, which doesn't know
// the join's row id, only the two beds and the date it was clicked on.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bed1Id = Number(body.bed1Id);
  const bed2Id = Number(body.bed2Id);
  const atDate = String(body.atDate ?? "");

  if (!Number.isInteger(bed1Id) || !Number.isInteger(bed2Id) || !atDate) {
    return NextResponse.json({ error: "bed1Id, bed2Id and atDate are required" }, { status: 400 });
  }

  const candidates = await db
    .select()
    .from(joinedBeds)
    .where(
      and(
        or(
          and(eq(joinedBeds.bed1Id, bed1Id), eq(joinedBeds.bed2Id, bed2Id)),
          and(eq(joinedBeds.bed1Id, bed2Id), eq(joinedBeds.bed2Id, bed1Id))
        ),
        or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, atDate))
      )
    );
  const active = candidates.find((j) => coversDate(j.startDate, j.endDate, atDate));
  if (!active) {
    return NextResponse.json({ error: "No active join covers that date" }, { status: 404 });
  }

  if (active.startDate === atDate) {
    // Splitting on the exact day it started leaves nothing behind — delete
    // rather than leave a zero-length row.
    await db.delete(joinedBeds).where(eq(joinedBeds.id, active.id));
    return NextResponse.json({ deleted: true, id: active.id });
  }

  const [updated] = await db
    .update(joinedBeds)
    .set({ endDate: atDate })
    .where(eq(joinedBeds.id, active.id))
    .returning();
  return NextResponse.json(updated);
}
