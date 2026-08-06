import { NextRequest, NextResponse } from "next/server";
import { buildHousekeepingSheet } from "@/lib/housekeeping";
import { isIsoDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isIsoDate(date)) {
    return NextResponse.json({ error: "date (yyyy-mm-dd) query param is required" }, { status: 400 });
  }
  const sheet = await buildHousekeepingSheet(date);
  return NextResponse.json({ date, ...sheet });
}
