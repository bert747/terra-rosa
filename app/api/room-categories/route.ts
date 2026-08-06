import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { roomCategories } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { logChange } from "@/lib/change-log";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(roomCategories).orderBy(asc(roomCategories.rank), asc(roomCategories.id));
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
  if (!name) return NextResponse.json({ error: "Category name is required" }, { status: 400 });

  // New categories default to the back of the order — staff drag it into
  // place afterward rather than guessing a rank up front.
  const rows = await db.select().from(roomCategories);
  const maxRank = rows.reduce((max, r) => Math.max(max, r.rank), -1);

  const [category] = await db.insert(roomCategories).values({ name, rank: maxRank + 1 }).returning();
  await logChange({ category: "layout", action: "Created room category", summary: `Created room category "${name}"` });
  return NextResponse.json(category, { status: 201 });
}
