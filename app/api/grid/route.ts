import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadGridData } from "@/lib/grid-data";
import { isIsoDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const MAX_DAYS = 731; // ~2 years — plenty for one fetch, still bounded.

// Backs the grid's incremental "load more as you scroll" fetches: an
// arbitrary [start, start+days) window, computed the same way as the
// server-rendered initial page load (see src/lib/grid-data.ts).
export async function GET(req: NextRequest) {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start") ?? "";
  const days = Number(searchParams.get("days") ?? "");

  if (!isIsoDate(start)) {
    return NextResponse.json({ error: "start must be an ISO date" }, { status: 400 });
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return NextResponse.json({ error: `days must be an integer between 1 and ${MAX_DAYS}` }, { status: 400 });
  }

  const data = await loadGridData(start, days);
  return NextResponse.json(data);
}
