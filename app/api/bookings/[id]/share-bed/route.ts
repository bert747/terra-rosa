import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth";
import { pairWithAnchor } from "@/lib/share-bed";

export const dynamic = "force-dynamic";

// "Shares Bed With" (coupled allocation) — see pairWithAnchor for the full
// bed-finding/joining logic, shared with auto-allocate.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const bookingId = Number(id);
  const body = await req.json();
  const partnerBookingId = Number(body.partnerBookingId);
  if (!Number.isInteger(partnerBookingId) || partnerBookingId === bookingId) {
    return NextResponse.json({ error: "A different partner booking is required" }, { status: 400 });
  }

  const result = await pairWithAnchor(bookingId, partnerBookingId, { requireBed: false });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ partnerBedId: result.bedId }, { status: 201 });
}
