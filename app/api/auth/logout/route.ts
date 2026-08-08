import { NextRequest, NextResponse } from "next/server";
import { destroySession, redirectUrl } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await destroySession();
  const url = redirectUrl("/login", req);
  return NextResponse.redirect(url, { status: 303 });
}
