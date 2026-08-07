import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { guestCategories } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";

export const dynamic = "force-dynamic";

// Accepts `name`, `colour`, `rank` and/or `active` — the Layout page's
// drag-to-reorder sends just `rank`, a rename sends just `name`, "Delete"
// (see DELETE below, which is really a soft-delete) could equally have
// been a PATCH { active: false }, but DELETE reads more honestly as "make
// this go away" from the settings UI even though nothing is removed.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();

  const updates: Partial<typeof guestCategories.$inferInsert> = {};
  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.colour !== undefined) updates.colour = String(body.colour).trim();
  if (body.rank !== undefined) updates.rank = Number(body.rank);
  if (body.active !== undefined) updates.active = Boolean(body.active);

  const [category] = await db.update(guestCategories).set(updates).where(eq(guestCategories.id, Number(id))).returning();
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  if (updates.name !== undefined) {
    await logChange({ category: "layout", action: "Renamed guest category", summary: `Renamed guest category to "${category.name}"` });
  }
  if (updates.active === true) {
    await logChange({ category: "layout", action: "Restored guest category", summary: `Restored guest category "${category.name}"` });
  }

  return NextResponse.json(category);
}

// A soft delete — existing bookings tagged with this category keep their
// colour/label unchanged (bookings.guestCategoryId keeps pointing at this
// row; only `active` flips), it just stops being offered for new/changed
// bookings from here on. See guestCategories' own schema comment for why
// this can't be a real row delete the way room categories' DELETE is.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const categoryId = Number(id);

  const [category] = await db
    .update(guestCategories)
    .set({ active: false })
    .where(eq(guestCategories.id, categoryId))
    .returning();
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  await logChange({ category: "layout", action: "Deleted guest category", summary: `Deleted guest category "${category.name}"` });
  return NextResponse.json({ ok: true });
}
