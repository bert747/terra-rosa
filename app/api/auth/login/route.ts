import { NextRequest, NextResponse } from "next/server";
import { createSession, redirectUrl, verifyPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");

  const user = await verifyPassword(email, password);
  if (!user) {
    const url = redirectUrl("/login?error=1", req);
    return NextResponse.redirect(url, { status: 303 });
  }

  await createSession(user.id);
  const url = redirectUrl(user.mustChangePassword ? "/change-password" : "/grid", req);
  return NextResponse.redirect(url, { status: 303 });
}
