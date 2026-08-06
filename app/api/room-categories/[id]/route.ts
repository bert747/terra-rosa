import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { roomCategories } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";

export const dynamic = "force-dynamic";

// Accepts `name` and/or `rank` — the Layout page's drag-to-reorder sends
// just `rank` (once per row landed in a new position), a rename sends just
// `name`.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();

  const updates: Partial<typeof roomCategories.$inferInsert> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.rank !== undefined) updates.rank = Number(body.rank);

  const [category] = await db.update(roomCategories).set(updates).where(eq(roomCategories.id, Number(id))).returning();
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  if (updates.name !== undefined) {
    await logChange({ category: "layout", action: "Renamed room category", summary: `Renamed room category to "${category.name}"` });
  }

  return NextResponse.json(category);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const categoryId = Number(id);

  const [category] = await db.select().from(roomCategories).where(eq(roomCategories.id, categoryId));
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  // Rooms in this category just fall back to no category (categoryId's own
  // ON DELETE SET NULL) rather than this being blocked — a deleted category
  // isn't a structural problem the way a floor/room with beds still in it
  // is, it's just "these rooms are one-of-a-kind again."
  await db.delete(roomCategories).where(eq(roomCategories.id, categoryId));
  await logChange({ category: "layout", action: "Deleted room category", summary: `Deleted room category "${category.name}"` });
  return NextResponse.json({ ok: true });
}
