import { NextRequest, NextResponse } from "next/server";
import { and, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireEditor } from "@/lib/auth";
import { publicUserColumns } from "@/db/users";
import { MIN_PASSWORD_LENGTH, isDuplicateEmail, isValidRole } from "@/lib/users";

export const dynamic = "force-dynamic";

/**
 * Number of editors OTHER than the given user. Used to refuse changes that
 * would leave the install with no editor at all — there is no way back from
 * that through the UI, since editing users requires the editor role.
 */
async function otherEditorCount(excludeUserId: number): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, "editor"), ne(users.id, excludeUserId)));
  return Number(row.value);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const body = await req.json();
  const updates: Partial<typeof users.$inferInsert> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    updates.name = name;
  }

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!email.includes("@")) {
      return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
    }
    updates.email = email;
  }

  if (body.role !== undefined) {
    if (!isValidRole(body.role)) {
      return NextResponse.json({ error: 'Role must be "editor" or "viewer"' }, { status: 400 });
    }
    // Demoting the last remaining editor would lock everyone out of user
    // management (and every other write) permanently.
    if (target.role === "editor" && body.role === "viewer" && (await otherEditorCount(userId)) === 0) {
      return NextResponse.json(
        { error: "This is the only editor — promote someone else before changing this role" },
        { status: 400 }
      );
    }
    updates.role = body.role;
  }

  if (body.password !== undefined) {
    const password = String(body.password);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 }
      );
    }
    updates.passwordHash = await hashPassword(password);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning(publicUserColumns);
    return NextResponse.json(user);
  } catch (err) {
    if (isDuplicateEmail(err)) {
      return NextResponse.json({ error: "Another user already has that email" }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let actor;
  try {
    actor = await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isInteger(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  if (userId === actor.id) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
  }

  const [target] = await db.select(publicUserColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (target.role === "editor" && (await otherEditorCount(userId)) === 0) {
    return NextResponse.json(
      { error: "This is the only editor — promote someone else before deleting" },
      { status: 400 }
    );
  }

  // Hard delete is safe: bookings.created_by and operational_notes.created_by
  // are ON DELETE SET NULL, so the user's records survive (minus attribution).
  const [deleted] = await db.delete(users).where(eq(users.id, userId)).returning(publicUserColumns);
  return NextResponse.json(deleted);
}
