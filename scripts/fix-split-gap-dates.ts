import "dotenv/config";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../src/db";
import { bookings } from "../src/db/schema";
import { addDays } from "../src/lib/occupancy";

// ---------------------------------------------------------------------------
// One-off data fix for split-booking chains imported by
// scripts/import-bookings.ts (the PMS handover bulk import): every
// non-final leg of a chain got its departureDate copied straight from the
// spreadsheet's "Departure Date" column, which for an interim room-change
// meant "last night in that room" rather than this app's own checkout-day
// (exclusive) convention. The result: a real 1-night gap between each part
// and the next — e.g. part A departureDate 2026-03-10, part B arrivalDate
// 2026-03-11, with the 10th itself unbooked in between, when it should read
// as one continuous stay with a same-day turnover (A's departureDate should
// have been 2026-03-11, matching B's arrivalDate exactly).
//
// Deliberately conditional, not a blanket "+1 day to every non-final leg":
// a split created through the app's own Split feature (GridCanvas ->
// POST /api/bookings/[id]/split) already sets its two halves back-to-back
// correctly — blindly adding a day there would introduce a 1-night OVERLAP
// instead of fixing anything. This only touches a pair where there's
// currently EXACTLY a 1-night gap between them; anything else (already
// adjacent, overlapping, or a bigger gap) is left alone and reported for a
// manual look, since guessing at those would risk making bad data worse.
//
//   npx tsx scripts/fix-split-gap-dates.ts          # dry run — reports only
//   npx tsx scripts/fix-split-gap-dates.ts --apply  # actually updates rows
// ---------------------------------------------------------------------------

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await db
    .select({
      id: bookings.id,
      guestName: bookings.guestName,
      splitGroupId: bookings.splitGroupId,
      arrivalDate: bookings.arrivalDate,
      departureDate: bookings.departureDate,
    })
    .from(bookings)
    .where(isNotNull(bookings.splitGroupId));

  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    const groupId = r.splitGroupId!;
    groups.set(groupId, [...(groups.get(groupId) ?? []), r]);
  }

  let gapsFound = 0;
  let gapsFixed = 0;
  const otherMismatches: string[] = [];

  for (const [groupId, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
    for (let i = 0; i < ordered.length - 1; i++) {
      const current = ordered[i];
      const next = ordered[i + 1];
      if (current.departureDate === next.arrivalDate) continue; // already correct, back-to-back
      const oneNightGap = addDays(current.departureDate, 1) === next.arrivalDate;
      if (!oneNightGap) {
        otherMismatches.push(
          `  Group ${groupId} (${current.guestName}): booking #${current.id} departs ${current.departureDate}, ` +
            `booking #${next.id} arrives ${next.arrivalDate} — not a plain 1-night gap, left alone.`
        );
        continue;
      }
      gapsFound += 1;
      console.log(
        `${apply ? "Fixing" : "Would fix"}: booking #${current.id} (${current.guestName}) departureDate ` +
          `${current.departureDate} -> ${next.arrivalDate} (closes 1-night gap before booking #${next.id})`
      );
      if (apply) {
        await db.update(bookings).set({ departureDate: next.arrivalDate }).where(eq(bookings.id, current.id));
        gapsFixed += 1;
      }
    }
  }

  console.log(`\n${apply ? "Fixed" : "Found"} ${gapsFound} one-night gap(s) across ${groups.size} split chain(s).`);
  if (!apply && gapsFound > 0) console.log("Re-run with --apply to actually update these rows.");
  if (otherMismatches.length > 0) {
    console.log(`\n${otherMismatches.length} pair(s) skipped (not a plain 1-night gap, needs a manual look):`);
    otherMismatches.forEach((m) => console.log(m));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fix failed:", err);
  process.exit(1);
});
