import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * The logged-in user's own record. Lets client components tell "this row is
 * you" apart from the others (to disable self-delete, for example) without
 * threading server state down through props.
 *
 * Sits alongside [id]/route.ts — Next.js matches the static "me" segment
 * before the dynamic one, so this never collides with /api/users/3.
 */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({ id: user.id, name: user.name, email: user.email, role: user.role });
  } catch {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
}
