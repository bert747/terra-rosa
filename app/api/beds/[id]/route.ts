import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { beds, bookings } from "@/db/schema";
import { requireEditor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const type = String(body.type ?? "").trim();
  if (!type) return NextResponse.json({ error: "Bed type is required" }, { status: 400 });

  const [bed] = await db.update(beds).set({ type }).where(eq(beds.id, Number(id))).returning();
  if (!bed) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  return NextResponse.json(bed);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bedId = Number(id);

  // Captured before the delete: the FK cascade (bookings.bed_id ON DELETE
  // SET NULL) unassigns these silently, so grab them first to report back.
  const unassignedBookings = await db.select().from(bookings).where(eq(bookings.bedId, bedId));

  const [bed] = await db.delete(beds).where(eq(beds.id, bedId)).returning();
  if (!bed) return NextResponse.json({ error: "Bed not found" }, { status: 404 });
  return NextResponse.json({ ...bed, unassignedBookings });
}
