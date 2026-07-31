import { NextRequest, NextResponse } from "next/server";
import { dietaryRequirementsForDates } from "@/lib/guests";

export const dynamic = "force-dynamic";

// Dietary requirements of everyone in-house, per date — what the kitchen needs
// alongside the headcounts from /api/meal-counts.
// GET /api/dietary?dates=2026-07-25,2026-07-26
export async function GET(req: NextRequest) {
  const datesParam = req.nextUrl.searchParams.get("dates") ?? req.nextUrl.searchParams.get("date");
  if (!datesParam) {
    return NextResponse.json(
      { error: "dates (comma-separated) or date query param is required" },
      { status: 400 }
    );
  }
  const dates = datesParam.split(",").map((d) => d.trim()).filter(Boolean);
  return NextResponse.json(await dietaryRequirementsForDates(dates));
}
