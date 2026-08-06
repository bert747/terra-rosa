import { db } from "@/db";
import { changeLogEntries } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";

export type ChangeLogCategory = "grid" | "bookings" | "events" | "layout";

/**
 * Records one line in the change history (see app/history/page.tsx) —
 * called after a mutation has already succeeded, never before, and never
 * something its own success depends on: a logging failure must not take
 * down the real feature it's describing, so this swallows its own errors
 * rather than propagating them to the caller.
 */
export async function logChange(entry: { category: ChangeLogCategory; action: string; summary: string }): Promise<void> {
  try {
    const user = await getCurrentUser();
    await db.insert(changeLogEntries).values({
      userId: user?.id ?? null,
      userName: user?.name ?? "Unknown",
      category: entry.category,
      action: entry.action,
      summary: entry.summary,
    });
  } catch {
    // Best-effort — see the doc comment above.
  }
}
