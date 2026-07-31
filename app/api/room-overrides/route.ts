import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { roomCapacityOverrides } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  const query = db.select().from(roomCapacityOverrides);
  const rows = roomId
    ? await query.where(eq(roomCapacityOverrides.roomId, Number(roomId)))
    : await query;
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const roomId = Number(body.roomId);
  const startDate = String(body.startDate);
  const endDate = String(body.endDate);
  const bedCount = Number(body.bedCount);
  const note = String(body.note ?? "").trim();

  if (!roomId || !startDate || !endDate || !Number.isInteger(bedCount) || bedCount < 0) {
    return NextResponse.json({ error: "roomId, startDate, endDate and a non-negative bedCount are required" }, { status: 400 });
  }
  if (!note) {
    return NextResponse.json({ error: "Override note is required" }, { status: 400 });
  }
  if (startDate >= endDate) {
    return NextResponse.json({ error: "startDate must be before endDate" }, { status: 400 });
  }

  // NOTE: the database has (or should have, via migration) a GIST exclusion
  // constraint preventing overlapping overrides per room. If that migration
  // hasn't been applied yet, this insert can still succeed with an overlap —
  // treat the DB constraint as the authoritative guard for production use.
  try {
    const [row] = await db
      .insert(roomCapacityOverrides)
      .values({ roomId, startDate, endDate, bedCount, note })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Could not create override — it may overlap an existing override for this room." },
      { status: 409 }
    );
  }
}
