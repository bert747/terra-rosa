import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { floors } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(floors).orderBy(asc(floors.name));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Floor name is required" }, { status: 400 });

  const [floor] = await db.insert(floors).values({ name }).returning();
  return NextResponse.json(floor, { status: 201 });
}
