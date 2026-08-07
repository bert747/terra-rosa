import { NextResponse } from "next/server";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { and, gte, isNull } from "drizzle-orm";
import { findAllocationIssues } from "@/lib/allocation-issues";
import { buildIssueGroups, type IssueGroup, type UnassignedAlert } from "@/lib/grid-data";

export const dynamic = "force-dynamic";

// The same "Alerts" data the grid's own toolbar button shows (see
// GridCanvas.tsx), but computed WITHOUT a date-window — the grid scopes
// alerts to whatever range is currently on screen since that's all it can
// usefully act on right there; a page like Bookings has no such window, so
// this just answers "every current/future unassigned booking or unmet
// pairing," full stop. Used by AlertsButton.tsx wherever it's mounted.
export async function GET() {
  const today = new Date().toISOString().slice(0, 10);

  const unassigned = await db
    .select({ id: bookings.id, guestName: bookings.guestName, arrivalDate: bookings.arrivalDate, departureDate: bookings.departureDate })
    .from(bookings)
    .where(and(isNull(bookings.bedId), gte(bookings.departureDate, today)));
  const alerts: UnassignedAlert[] = unassigned;

  const allocationIssues = await findAllocationIssues();
  const allBookings = await db.select({ id: bookings.id, guestName: bookings.guestName, departureDate: bookings.departureDate }).from(bookings);

  const issues = allBookings
    .filter((b) => b.departureDate >= today && (allocationIssues.get(b.id) ?? []).length > 0)
    .map((b) => ({ id: b.id, guestName: b.guestName, issues: allocationIssues.get(b.id)! }));

  const issueGroups: IssueGroup[] = buildIssueGroups(issues);

  return NextResponse.json({ alerts, issueGroups });
}
