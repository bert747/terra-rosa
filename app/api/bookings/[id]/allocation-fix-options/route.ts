import { NextRequest, NextResponse } from "next/server";
import { findGroupRoomFixOptions } from "@/lib/allocation-fixes";

export const dynamic = "force-dynamic";

// Read-only lookup for the booking edit page's allocation-issue banner —
// resolves this booking's WHOLE relationship group (every "Sleeps
// near"/"Shares bed with" link transitively tied to it), not just the two
// bookings behind one issue, so a suggested room satisfies every
// requirement at once. Applying a chosen option goes through the existing
// POST /api/bookings/auto-allocate/apply-move.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bookingId = Number(id);
  if (!Number.isInteger(bookingId)) {
    return NextResponse.json({ error: "Invalid booking id" }, { status: 400 });
  }

  const options = await findGroupRoomFixOptions(bookingId);
  return NextResponse.json({ options });
}
