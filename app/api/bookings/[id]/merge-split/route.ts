import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth";
import { previewSplitMerge, applySplitMerge } from "@/lib/split-merge";

export const dynamic = "force-dynamic";

// Merges every future part of a split booking back onto whichever bed the
// CLICKED part is on — see src/lib/split-merge.ts for the actual algorithm
// (split-at-today, then chain-merge). No body (or an empty one): attempts
// the merge outright, applying it immediately if the target bed is free;
// if something's in the way, responds 409 with the conflict(s) instead of
// touching anything, same two-step shape as the join-conflict flow
// (POST /api/joined-beds). `{ resolution: "swap" | "unallocate" }`: applies
// with that specific resolution, once the caller has picked one.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bookingId = Number(id);
  const body = await req.json().catch(() => ({}));
  const resolution = body.resolution === "swap" ? "swap" : body.resolution === "unallocate" ? "unallocate" : undefined;

  if (!resolution) {
    const preview = await previewSplitMerge(bookingId);
    if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 400 });
    if (preview.alreadyMerged) return NextResponse.json({ ok: true, applied: false });
    if (preview.conflicts.length > 0) {
      return NextResponse.json({ conflicts: preview.conflicts, canSwap: preview.canSwap }, { status: 409 });
    }
  }

  const result = await applySplitMerge(bookingId, resolution);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true, applied: true, resultBookingId: result.resultBookingId });
}
