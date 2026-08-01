import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { joinedBeds } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Splits a joined pair back into two independent beds, ending the join today
// (not deleting it, so the pairing stays in history — same convention as
// bed_locations).
export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const today = new Date().toISOString().slice(0, 10);

  const [join] = await db
    .update(joinedBeds)
    .set({ endDate: today })
    .where(eq(joinedBeds.id, Number(id)))
    .returning();

  if (!join) return NextResponse.json({ error: "Join not found" }, { status: 404 });
  return NextResponse.json(join);
}
