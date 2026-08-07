import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { parseEventBody } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId < 1) {
    return NextResponse.json({ error: "Invalid event id" }, { status: 400 });
  }

  const { name, startDate, endDate, notes, colour } = parseEventBody(await req.json());
  if (!name || !startDate || !endDate) {
    return NextResponse.json({ error: "name, startDate and endDate are required" }, { status: 400 });
  }
  if (endDate < startDate) {
    return NextResponse.json({ error: "End date cannot be before the start date" }, { status: 400 });
  }

  const updates: Partial<typeof events.$inferInsert> = { name, startDate, endDate, notes };
  if (colour !== undefined) updates.colour = colour;

  const [row] = await db
    .update(events)
    .set(updates)
    .where(eq(events.id, eventId))
    .returning();

  if (!row) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  await logChange({ category: "events", action: "Updated event", summary: `Updated event "${row.name}", ${row.startDate} to ${row.endDate}` });
  return NextResponse.json(row);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const eventId = Number(id);
  if (!Number.isInteger(eventId) || eventId < 1) {
    return NextResponse.json({ error: "Invalid event id" }, { status: 400 });
  }

  const [row] = await db.delete(events).where(eq(events.id, eventId)).returning();
  if (!row) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  await logChange({ category: "events", action: "Deleted event", summary: `Deleted event "${row.name}", ${row.startDate} to ${row.endDate}` });
  return NextResponse.json({ ok: true });
}
