import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireEditor } from "@/lib/auth";
import { generateTempPassword } from "@/lib/users";
import { publicUserColumns } from "@/db/users";

export const dynamic = "force-dynamic";

/**
 * Generates a random temporary password, saves its hash, and flags the
 * account to force a real password choice on next login (see
 * users.mustChangePassword and /change-password) — replaces the old flow
 * where an editor typed a new password themselves via a browser prompt and
 * had to relay it out of band with no forcing function behind it. Returns
 * the plaintext temp password ONCE, in this response only — it is never
 * stored or logged anywhere, so if this response is lost the only recovery
 * is to reset again.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const [target] = await db.select(publicUserColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  await db.update(users).set({ passwordHash, mustChangePassword: true }).where(eq(users.id, userId));

  return NextResponse.json({ email: target.email, tempPassword });
}
