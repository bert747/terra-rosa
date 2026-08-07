import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireUser } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH } from "@/lib/users";

export const dynamic = "force-dynamic";

// Any logged-in user (editor or viewer) can change their OWN password this
// way — unlike PATCH /api/users/[id], which is editor-only and targets
// someone ELSE's account. Always clears mustChangePassword, whether or not
// it was set, since choosing your own password is the thing that flag is
// waiting for either way.
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }

  const body = await req.json();
  const password = String(body.password ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);
  await db.update(users).set({ passwordHash, mustChangePassword: false }).where(eq(users.id, user.id));

  return NextResponse.json({ ok: true });
}
