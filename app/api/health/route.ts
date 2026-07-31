import { NextResponse } from "next/server";

// Simple liveness check used by Docker's healthcheck. Does not touch the
// database on purpose — keep it fast and dependency-free.
export async function GET() {
  return NextResponse.json({ ok: true });
}
