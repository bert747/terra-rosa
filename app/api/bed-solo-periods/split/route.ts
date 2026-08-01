import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bedSoloPeriods } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { and, eq, gt, isNull, or } from "drizzle-orm";

export const dynamic = "force-dynamic";

function coversDate(startDate: string, endDate: string | null, date: string): boolean {
  return startDate <= date && (endDate == null || endDate > date);
}

// Switches a native two-person bed back to selling as a couple: ends
// whichever solo period covers `atDate` — used by the grid's right-click
// "Switch to Couple" / "Split" action, which knows only the bed and the date
// it was clicked on, not the period's row id.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const bedId = Number(body.bedId);
  const atDate = String(body.atDate ?? "");

  if (!Number.isInteger(bedId) || !atDate) {
    return NextResponse.json({ error: "bedId and atDate are required" }, { status: 400 });
  }

  const candidates = await db
    .select()
    .from(bedSoloPeriods)
    .where(and(eq(bedSoloPeriods.bedId, bedId), or(isNull(bedSoloPeriods.endDate), gt(bedSoloPeriods.endDate, atDate))));
  const active = candidates.find((p) => coversDate(p.startDate, p.endDate, atDate));
  if (!active) {
    return NextResponse.json({ error: "No active solo period covers that date" }, { status: 404 });
  }

  if (active.startDate === atDate) {
    await db.delete(bedSoloPeriods).where(eq(bedSoloPeriods.id, active.id));
    return NextResponse.json({ deleted: true, id: active.id });
  }

  const [updated] = await db
    .update(bedSoloPeriods)
    .set({ endDate: atDate })
    .where(eq(bedSoloPeriods.id, active.id))
    .returning();
  return NextResponse.json(updated);
}
