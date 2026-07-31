import { NextRequest, NextResponse } from "next/server";
import { mealCountsForDate } from "@/lib/occupancy";

export const dynamic = "force-dynamic";

// Returns computed breakfast/lunch/dinner counts for one or more dates.
// GET /api/meal-counts?dates=2026-07-25,2026-07-26
export async function GET(req: NextRequest) {
  const datesParam = req.nextUrl.searchParams.get("dates") ?? req.nextUrl.searchParams.get("date");
  if (!datesParam) {
    return NextResponse.json({ error: "dates (comma-separated) or date query param is required" }, { status: 400 });
  }
  const dates = datesParam.split(",").map((d) => d.trim()).filter(Boolean);
  const results = await Promise.all(dates.map((d) => mealCountsForDate(d)));
  return NextResponse.json(results);
}
