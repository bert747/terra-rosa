import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { changeLogEntries } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { desc, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

const CATEGORIES = ["grid", "bookings", "events", "layout"] as const;
const PAGE_SIZE = 100;

// Read-only — any logged-in user (viewer or editor) can see the history,
// same as every other list page in the app; only the mutations that WRITE
// to this table require editor. See src/lib/change-log.ts for those.
export async function GET(req: NextRequest) {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  // A ticked row of checkboxes on the client (see app/history/page.tsx),
  // not a single-select dropdown — multiple ?category= params combine as
  // an OR (grid OR bookings OR …), not narrowed further, since an entry
  // only ever has exactly one category anyway.
  const requested = req.nextUrl.searchParams.getAll("category").filter((c): c is (typeof CATEGORIES)[number] => (CATEGORIES as readonly string[]).includes(c));

  const rows = await db
    .select()
    .from(changeLogEntries)
    .where(requested.length > 0 ? inArray(changeLogEntries.category, requested) : undefined)
    .orderBy(desc(changeLogEntries.createdAt))
    .limit(PAGE_SIZE);

  return NextResponse.json(rows);
}
