import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { operationalNotes } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  const query = db.select().from(operationalNotes);
  const rows = date
    ? await query.where(eq(operationalNotes.date, date)).orderBy(desc(operationalNotes.createdAt))
    : await query.orderBy(desc(operationalNotes.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const date = String(body.date ?? "");
  const noteText = String(body.noteText ?? "").trim();
  if (!date || !noteText) {
    return NextResponse.json({ error: "date and noteText are required" }, { status: 400 });
  }

  const [row] = await db
    .insert(operationalNotes)
    .values({
      date,
      roomId: body.roomId ? Number(body.roomId) : null,
      bookingId: body.bookingId ? Number(body.bookingId) : null,
      noteText,
      createdBy: user.id,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
