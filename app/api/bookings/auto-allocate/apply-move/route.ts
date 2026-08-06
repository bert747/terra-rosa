import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth";
import { applyGroupMoveProposal } from "@/lib/group-move";
import { applyEvictions, type EvictionResult, type EvictionStep } from "@/lib/allocation-fixes";

export const dynamic = "force-dynamic";

// Applies a GroupMoveProposal returned by POST /api/bookings/auto-allocate
// (see that route's `proposals` array) once staff has confirmed it — never
// invoked automatically. The client sends back exactly the `moves` and
// `rejoinBookingIds` it was given; capacity is re-checked against live data
// inside the transaction before anything is written, since time may have
// passed between the proposal being shown and confirmed.
export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const moves = Array.isArray(body.moves) ? body.moves : null;
  // Two request shapes: the single-couple `rejoinBookingIds` pair the grid's
  // auto-allocate proposals send, or the plural `rejoins` array a
  // whole-group fix (more than one couple relocating at once) can need —
  // normalised to one array either way.
  const rejoins: [number, number][] = Array.isArray(body.rejoins)
    ? body.rejoins
    : Array.isArray(body.rejoinBookingIds) && body.rejoinBookingIds.length === 2
      ? [body.rejoinBookingIds as [number, number]]
      : [];

  const evictions: EvictionStep[] = Array.isArray(body.evictions) ? body.evictions : [];

  if (!moves || moves.some((m: unknown) => {
    const move = m as { bookingId?: unknown; bedId?: unknown };
    return !Number.isInteger(move.bookingId) || !Number.isInteger(move.bedId);
  })) {
    return NextResponse.json({ error: "moves (bookingId/bedId pairs) are required" }, { status: 400 });
  }

  // Evictions relocate a THIRD-PARTY booking out of the way first (see
  // findGroupRoomFixOptions' second pass) — applied before, and separately
  // from, the group's own moves, since they touch an unrelated booking the
  // group-move transaction has no reason to know about.
  let evictionResults: EvictionResult[] = [];
  if (evictions.length > 0) {
    const evictionResult = await applyEvictions(evictions);
    if (!evictionResult.ok) {
      return NextResponse.json({ error: evictionResult.error }, { status: 409 });
    }
    evictionResults = evictionResult.results;
  }

  const result = await applyGroupMoveProposal({ moves, rejoins });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, evictionResults, closedJoins: result.closedJoins, createdJoins: result.createdJoins });
}
