import { NextRequest, NextResponse } from "next/server";
import { createSession, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");

  const user = await verifyPassword(email, password);
  if (!user) {
    const url = new URL("/login?error=1", req.url);
    return NextResponse.redirect(url, { status: 303 });
  }

  await createSession(user.id);
  const url = new URL("/dashboard", req.url);
  return NextResponse.redirect(url, { status: 303 });
}
