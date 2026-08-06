import { NextRequest, NextResponse } from "next/server";
import { findSplitSiblings } from "@/lib/split-siblings";

export const dynamic = "force-dynamic";

// Every OTHER part of this booking's split lineage, earliest first — powers
// the booking edit page's prev/next arrows (and could back the grid's own
// chevrons too, though those currently read straight off GridData.splitGroups
// since they need every lineage in the system, not just one booking's own).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const siblings = await findSplitSiblings(Number(id));
  return NextResponse.json(siblings);
}
