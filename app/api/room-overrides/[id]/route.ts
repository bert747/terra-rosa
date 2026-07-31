import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { roomCapacityOverrides } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Removes one dated bed-count override, so the room falls back to its default
 * bed count over those dates again.
 *
 * This is how a dated bed move gets undone. Note that a move writes an override
 * on BOTH rooms (-n on one, +n on the other), so deleting only one side leaves
 * the house's bed total looking wrong for those dates — the Rooms page deletes
 * the matching pair together.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const [deleted] = await db
    .delete(roomCapacityOverrides)
    .where(eq(roomCapacityOverrides.id, Number(id)))
    .returning();

  if (!deleted) return NextResponse.json({ error: "Override not found" }, { status: 404 });
  return NextResponse.json(deleted);
}
