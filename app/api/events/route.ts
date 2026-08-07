import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { events } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { asc } from "drizzle-orm";
import { parseEventBody } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(events).orderBy(asc(events.startDate));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }
  const { name, startDate, endDate, notes, colour } = parseEventBody(await req.json());
  if (!name || !startDate || !endDate) {
    return NextResponse.json({ error: "name, startDate and endDate are required" }, { status: 400 });
  }
  // endDate is inclusive (see src/lib/event-lanes.ts), so end == start is a
  // legitimate one-day event. end < start would just render as nothing on the
  // grid, which reads as "my event vanished" rather than as an input error.
  if (endDate < startDate) {
    return NextResponse.json(
      { error: "End date cannot be before the start date" },
      { status: 400 }
    );
  }
  const [row] = await db.insert(events).values({ name, startDate, endDate, notes, colour: colour ?? null }).returning();
  await logChange({ category: "events", action: "Created event", summary: `Created event "${name}", ${startDate} to ${endDate}` });
  return NextResponse.json(row, { status: 201 });
}
