import "dotenv/config";
import { db } from "../src/db";
import { rooms } from "../src/db/schema";
import { roomBedsForRoom, sumBedCapacity, syncRoomBedCount } from "../src/lib/room-beds";

// ---------------------------------------------------------------------------
// Recomputes every room's `default_bed_count` from its actual bed rows.
//
// Read-only as far as beds themselves go — it adds and removes nothing, it just
// makes the capacity column agree with the furniture. Run it after changing how
// beds are counted, or any time the number on the Rooms page looks wrong next to
// the bed tokens beside it.
//
// The reason it exists: `default_bed_count` used to be a plain COUNT of
// room_beds rows, so joining two singles into a `joined_single_pair` (one row,
// two beds) silently halved the room's capacity. Rooms edited while that was
// true still hold the wrong number until this runs.
//
//   npm run rooms:resync-beds
//   npm run rooms:resync-beds -- --dry
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");

async function main() {
  const all = await db.select().from(rooms);
  let changed = 0;
  let totalBeds = 0;

  for (const room of all) {
    const beds = await roomBedsForRoom(room.id);
    const correct = sumBedCapacity(beds);
    if (room.isActive) totalBeds += correct;

    if (correct === room.defaultBedCount) continue;

    const joined = beds.filter((bed) => bed.bedType === "joined_single_pair").length;
    console.log(
      `${dryRun ? "would fix" : "fixed   "} ${room.name.padEnd(16)} ${room.defaultBedCount} -> ${correct} beds ` +
        `(${beds.length} row${beds.length === 1 ? "" : "s"}${joined > 0 ? `, ${joined} joined pair(s)` : ""})`
    );
    if (!dryRun) await syncRoomBedCount(room.id);
    changed++;
  }

  console.log(
    `\n${dryRun ? "Dry run: " : ""}${changed} room(s) ${dryRun ? "would be corrected" : "corrected"}. ` +
      `${totalBeds} beds across active rooms.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Bed count resync failed:", err);
  process.exit(1);
});
