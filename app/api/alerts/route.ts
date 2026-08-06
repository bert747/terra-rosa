import { NextResponse } from "next/server";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { and, gte, isNull } from "drizzle-orm";
import { findAllocationIssues } from "@/lib/allocation-issues";
import type { IssueGroup, UnassignedAlert } from "@/lib/grid-data";

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
  const guestNameById = new Map(allBookings.map((b) => [b.id, b.guestName]));

  const issues = allBookings
    .filter((b) => b.departureDate >= today && (allocationIssues.get(b.id) ?? []).length > 0)
    .map((b) => ({ id: b.id, guestName: b.guestName, issues: allocationIssues.get(b.id)! }));

  // Same connected-groups reconstruction the grid's own /api/grid route
  // uses — every issue is flagged on BOTH bookings it involves, so the
  // issues list alone already contains every edge needed.
  const adjacency = new Map<number, Set<number>>();
  for (const i of issues) {
    for (const rel of i.issues) {
      if (!adjacency.has(i.id)) adjacency.set(i.id, new Set());
      adjacency.get(i.id)!.add(rel.otherBookingId);
    }
  }
  const visited = new Set<number>();
  const issueGroups: IssueGroup[] = [];
  for (const i of issues) {
    if (visited.has(i.id)) continue;
    const stack = [i.id];
    const memberIds: number[] = [];
    visited.add(i.id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      memberIds.push(cur);
      for (const next of adjacency.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    issueGroups.push({ bookingId: memberIds[0], guestNames: memberIds.map((id) => guestNameById.get(id) ?? "?") });
  }

  return NextResponse.json({ alerts, issueGroups });
}
