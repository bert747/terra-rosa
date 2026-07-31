import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { hashPassword, requireEditor } from "@/lib/auth";
import { publicUserColumns } from "@/db/users";
import { MIN_PASSWORD_LENGTH, isDuplicateEmail, isValidRole } from "@/lib/users";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const all = await db.select(publicUserColumns).from(users).orderBy(asc(users.id));
  return NextResponse.json(all);
}

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  const body = await req.json();
  const name = String(body.name ?? "").trim();
  // Lowercased to match the login route, which lowercases what the user types.
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const role = body.role ?? "editor";

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!email.includes("@")) return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      { status: 400 }
    );
  }
  if (!isValidRole(role)) {
    return NextResponse.json({ error: 'Role must be "editor" or "viewer"' }, { status: 400 });
  }

  try {
    const [user] = await db
      .insert(users)
      .values({ name, email, passwordHash: await hashPassword(password), role })
      .returning(publicUserColumns);
    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    if (isDuplicateEmail(err)) {
      return NextResponse.json({ error: `A user with email ${email} already exists` }, { status: 409 });
    }
    throw err;
  }
}
