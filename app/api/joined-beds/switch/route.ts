import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { findActiveJoin, unassignSoloOverlap } from "@/lib/joined-beds";

export const dynamic = "force-dynamic";

const FAR_FUTURE = "9999-12-31";

// Switches an ALREADY-joined pair's mode at `atDate` in one step: ends
// whichever segment currently covers that date and starts a new one there
// with the new mode — used by the grid's right-click "Switch to Couple /
// Solo Double" action on cells that are already joined (as opposed to
// POST /api/joined-beds, which creates a join from scratch).
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
  const mode = body.mode === "solo" ? "solo" : body.mode === "double" ? "double" : null;

  if (!Number.isInteger(bed1Id) || !Number.isInteger(bed2Id) || !atDate) {
    return NextResponse.json({ error: "bed1Id, bed2Id and atDate are required" }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: "Mode must be 'double' or 'solo'" }, { status: 400 });
  }

  const active = await findActiveJoin(bed1Id, bed2Id, atDate);
  if (!active) {
    return NextResponse.json({ error: "No active join covers that date" }, { status: 404 });
  }
  if (active.mode === mode) {
    return NextResponse.json({ error: `Already ${mode}` }, { status: 409 });
  }

  const priorEndDate = active.endDate;
  if (active.startDate === atDate) {
    await db.delete(joinedBeds).where(eq(joinedBeds.id, active.id));
  } else {
    await db.update(joinedBeds).set({ endDate: atDate }).where(eq(joinedBeds.id, active.id));
  }

  // Preserve bed1/bed2 orientation (isPrimary matters for "solo").
  const [created] = await db
    .insert(joinedBeds)
    .values({ bed1Id: active.bed1Id, bed2Id: active.bed2Id, startDate: atDate, endDate: priorEndDate, mode })
    .returning();

  const unassignedBookings =
    mode === "solo" ? await unassignSoloOverlap(active.bed2Id, atDate, priorEndDate ?? FAR_FUTURE) : [];

  return NextResponse.json({ ...created, unassignedBookings });
}
