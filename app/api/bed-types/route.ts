import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { bedTypes } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { listBedTypes } from "@/lib/bed-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await listBedTypes();
  return NextResponse.json(rows);
}

// Adds a new bed type to the catalogue (e.g. "Bunk") — inventory of beds of
// this type is then added/removed per room via POST /api/beds and
// DELETE /api/beds/[id]. capacity is fixed at creation: how many guests one
// bed of this type sleeps (1 or 2), since nothing here can infer that from
// an arbitrary name the way the old hardcoded "1.5"/"double"/"queen"
// substring match did.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  const capacity = Number(body.capacity);

  if (!name) {
    return NextResponse.json({ error: "A name is required" }, { status: 400 });
  }
  if (capacity !== 1 && capacity !== 2) {
    return NextResponse.json({ error: "Capacity must be 1 (sleeps 1) or 2 (sleeps 2)" }, { status: 400 });
  }

  const existing = await listBedTypes();
  if (existing.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    return NextResponse.json({ error: `"${name}" already exists` }, { status: 400 });
  }

  const [row] = await db.insert(bedTypes).values({ name, capacity }).returning();
  return NextResponse.json(row, { status: 201 });
}
