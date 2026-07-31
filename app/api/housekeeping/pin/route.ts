import { NextRequest, NextResponse } from "next/server";
import { checkHousekeepingPin, setHousekeepingPinCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const pin = String(form.get("pin") ?? "");

  const ok = await checkHousekeepingPin(pin);
  if (!ok) {
    const url = new URL("/housekeeping?error=1", req.url);
    return NextResponse.redirect(url, { status: 303 });
  }

  await setHousekeepingPinCookie();
  const url = new URL("/housekeeping", req.url);
  return NextResponse.redirect(url, { status: 303 });
}
