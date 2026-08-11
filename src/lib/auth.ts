import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";

// ---------------------------------------------------------------------------
// Deliberately simple auth — no NextAuth/Auth.js dependency.
//
// This is a 1-3 user internal tool, so we use a signed cookie session instead
// of a full auth framework:
//   - Password hashing: bcrypt (bcryptjs, pure JS, no native build step).
//   - Session token: "<userId>.<expiresAtMs>" HMAC-signed with SESSION_SECRET,
//     stored in an httpOnly, sameSite=lax cookie. No server-side session
//     store needed (nothing to expire in a DB, nothing to clean up).
//   - Roles: 'editor' (full CRUD) vs 'viewer' (read-only). Enforced in
//     server actions/route handlers via requireEditor().
//   - The housekeeping view does NOT use this system at all — it's an
//     unlisted URL gated only by a PIN (see requireHousekeepingPin below),
//     by design, so cleaning staff never need an account.
// ---------------------------------------------------------------------------

const COOKIE_NAME = "tr_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Redirect target behind the reverse proxy: `req.url` in a self-hosted
 * `next start` server resolves to the app's own bind address (localhost:PORT),
 * not the client-facing domain, even when the Host header is correct. Caddy
 * sets X-Forwarded-Host/-Proto, so build the absolute URL from those.
 */
export function redirectUrl(path: string, req: NextRequest): URL {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return new URL(path, `${proto}://${host}`);
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set. Copy .env.example to .env and fill in real values.");
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function makeToken(userId: number, expiresAt: number): string {
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): { userId: number; expiresAt: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expiresAtStr, signature] = parts;
  const payload = `${userIdStr}.${expiresAtStr}`;
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAt = Number(expiresAtStr);
  if (Number.isNaN(expiresAt) || Date.now() > expiresAt) return null;

  const userId = Number(userIdStr);
  if (Number.isNaN(userId)) return null;

  return { userId, expiresAt };
}

export async function createSession(userId: number, req: NextRequest) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const token = makeToken(userId, expiresAt);
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: proto === "https",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

/** Returns the logged-in user, or null if not logged in / session invalid. */
export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const parsed = verifyToken(token);
  if (!parsed) return null;

  const rows = await db.select().from(users).where(eq(users.id, parsed.userId)).limit(1);
  return rows[0] ?? null;
}

/** Throws if not logged in. Use at the top of server actions / route handlers. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return user;
}

/** Throws if not logged in as an editor. Use before any create/update/delete. */
export async function requireEditor(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "editor") throw new Error("Editor role required for this action");
  return user;
}

export async function verifyPassword(email: string, password: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
