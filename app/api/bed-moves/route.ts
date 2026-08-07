import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth";
import {
  cancelPlannedMoves,
  cancelPlannedJoinChange,
  delayPlannedMoves,
  delayPlannedJoinChange,
  findBookingsAffectedByCancel,
} from "@/lib/bed-moves";

export const dynamic = "force-dynamic";

/** The day after the last of `affected`'s bookings departs — the earliest date a blocked change could still happen. */
function latestPushedDate(affected: { departureDate: string }[]): string {
  return affected.reduce((max, a) => (a.departureDate > max ? a.departureDate : max), affected[0].departureDate);
}

// Cancels (or delays — see below) one or more planned changes (see
// findPlannedChanges) — body is `{ bedLocationIds?: number[],
// joinCancellations?: { id: number; kind: "start" | "end" }[], confirmed?:
// boolean, action?: "cancel" | "delay" }`, the exact rows a "Planned
// Changes" panel line (or the whole list, for "Delete all planned changes")
// carries. Both kinds can be cancelled/delayed in one call so "delete all"
// only needs one request. The grid picks up the change on its next
// refresh, same as any other edit.
//
// Without `confirmed: true`, a cancel that would leave an existing booking
// assuming a room/bed-type layout that never actually arrives (see
// findBookingsAffectedByCancel) responds 409 with the affected bookings AND
// `pushedDate` — the day after the last of them departs, i.e. the earliest
// date the change COULD still happen — instead of touching anything. Same
// two-step "preview, then resubmit once acknowledged" shape as the
// join-conflict and split-merge-conflict flows. Resubmitting with
// `confirmed: true` cancels regardless; resubmitting with `action: "delay"`
// instead pushes the change's own effective date out to `pushedDate` rather
// than abandoning it.
export async function DELETE(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const bedLocationIds = Array.isArray(body.bedLocationIds) ? body.bedLocationIds.map(Number).filter(Number.isInteger) : [];
  const joinCancellations: { id: number; kind: "start" | "end" }[] = Array.isArray(body.joinCancellations)
    ? body.joinCancellations
        .map((c: { id?: unknown; kind?: unknown }) => ({ id: Number(c.id), kind: c.kind === "end" ? "end" : "start" }))
        .filter((c: { id: number }) => Number.isInteger(c.id))
    : [];
  const confirmed = body.confirmed === true;
  const action = body.action === "delay" ? "delay" : "cancel";

  if (bedLocationIds.length === 0 && joinCancellations.length === 0) {
    return NextResponse.json({ error: "bedLocationIds or joinCancellations is required" }, { status: 400 });
  }

  if (!confirmed && action === "cancel") {
    const affected = await findBookingsAffectedByCancel(bedLocationIds, joinCancellations);
    if (affected.length > 0) {
      return NextResponse.json({ affected, pushedDate: latestPushedDate(affected) }, { status: 409 });
    }
  }

  if (action === "delay") {
    const affected = await findBookingsAffectedByCancel(bedLocationIds, joinCancellations);
    if (affected.length === 0) {
      return NextResponse.json({ error: "Nothing to delay — this change no longer conflicts with anything." }, { status: 400 });
    }
    const pushedDate = latestPushedDate(affected);
    const delayed = bedLocationIds.length > 0 ? await delayPlannedMoves(bedLocationIds, pushedDate) : [];
    const delayedJoins = [];
    for (const c of joinCancellations) {
      const result = await delayPlannedJoinChange(c.id, c.kind, pushedDate);
      if (result) delayedJoins.push(result);
    }
    return NextResponse.json({ ok: true, delayed, delayedJoins, pushedDate });
  }

  const cancelled = bedLocationIds.length > 0 ? await cancelPlannedMoves(bedLocationIds) : [];
  const cancelledJoins = [];
  for (const c of joinCancellations) {
    const result = await cancelPlannedJoinChange(c.id, c.kind);
    if (result) cancelledJoins.push(result);
  }

  return NextResponse.json({ ok: true, cancelled, cancelledJoins });
}
