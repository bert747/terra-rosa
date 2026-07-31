import "dotenv/config";
import { writeFileSync } from "fs";
import { like } from "drizzle-orm";
import { db } from "../src/db";
import { roomCapacityOverrides, rooms } from "../src/db/schema";
import { TERRA_ROSA_ROOMS } from "../src/lib/room-list";
import { setRoomBedCount } from "../src/lib/room-beds";

// ---------------------------------------------------------------------------
// Resets every room's beds to the count in src/lib/room-list.ts, which is what
// the occupancy spreadsheet's row layout says (see the long comment at the top
// of that file for how those numbers were read off it).
//
// This is the repair tool for a database whose bed counts have drifted — e.g.
// from the old Rooms-page bed mover, which deleted the bed from the source room
// and never added it to the target, so beds quietly went missing.
//
// It rewrites `room_beds` rows (adding plain singles, removing the
// highest-numbered beds) and resyncs `rooms.default_bed_count` from them, so
// the number and the bed tokens on the Rooms page agree afterwards. Bed TYPES
// are not touched on rooms that already have the right count, so a queen or a
// joined pair someone recorded survives a re-run.
//
// Rooms in the database but not in the list are left alone and reported.
//
// Capacity overrides are left alone by default: they're dated statements about
// particular weeks, not part of the house's standing bed count. The exception
// is --clear-setup-overrides, which removes the ones the old editor generated
// (note "Room setup change"): it wrote one on every room edit, whether or not
// the edit had anything to do with capacity, so a room could be pinned to one
// bed for a week by someone fixing a typo in its name. Those rows are dumped
// to a JSON file before being deleted, so the cleanup can be undone.
//
//   npm run rooms:reset-beds            # apply
//   npm run rooms:reset-beds -- --dry   # show what would change
//   npm run rooms:reset-beds -- --clear-setup-overrides
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const clearSetupOverrides = process.argv.includes("--clear-setup-overrides");
const SETUP_OVERRIDE_NOTE = "Room setup change";

async function main() {
  const existing = await db.select().from(rooms);
  const byName = new Map(existing.map((room) => [room.name.trim().toLowerCase(), room]));

  let changed = 0;
  let alreadyRight = 0;
  const missing: string[] = [];
  let wantedTotal = 0;

  for (const wanted of TERRA_ROSA_ROOMS) {
    const room = byName.get(wanted.name.trim().toLowerCase());
    wantedTotal += wanted.defaultBedCount;

    if (!room) {
      missing.push(wanted.name);
      continue;
    }

    if (room.defaultBedCount === wanted.defaultBedCount) {
      alreadyRight++;
      continue;
    }

    console.log(
      `${dryRun ? "would set" : "set     "} ${room.name.padEnd(16)} ${room.defaultBedCount} -> ${wanted.defaultBedCount} beds`
    );
    if (!dryRun) await setRoomBedCount(room.id, wanted.defaultBedCount);
    changed++;
  }

  if (clearSetupOverrides) {
    const doomed = await db
      .select()
      .from(roomCapacityOverrides)
      .where(like(roomCapacityOverrides.note, `${SETUP_OVERRIDE_NOTE}%`));

    if (doomed.length === 0) {
      console.log(`\nNo "${SETUP_OVERRIDE_NOTE}" overrides to clear.`);
    } else {
      const roomNames = new Map(existing.map((room) => [room.id, room.name]));
      for (const row of doomed) {
        console.log(
          `${dryRun ? "would drop" : "dropped  "} override ${roomNames.get(row.roomId) ?? row.roomId} ` +
            `${row.startDate}..${row.endDate} = ${row.bedCount} beds`
        );
      }
      if (!dryRun) {
        const backup = `room-capacity-overrides-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        writeFileSync(backup, JSON.stringify(doomed, null, 2));
        await db.delete(roomCapacityOverrides).where(like(roomCapacityOverrides.note, `${SETUP_OVERRIDE_NOTE}%`));
        console.log(`\nDropped ${doomed.length} override(s); backed up to ${backup} first.`);
      }
    }
  }

  const unlisted = existing.filter(
    (room) => room.isActive && !TERRA_ROSA_ROOMS.some((w) => w.name.trim().toLowerCase() === room.name.trim().toLowerCase())
  );
  for (const room of unlisted) {
    console.log(`- skipped  ${room.name.padEnd(16)} not in the room list (${room.defaultBedCount} beds, left as is)`);
  }

  console.log(
    `\n${dryRun ? "Dry run: " : ""}${changed} room(s) ${dryRun ? "would change" : "changed"}, ` +
      `${alreadyRight} already correct, ${unlisted.length} not in the list.`
  );
  if (missing.length > 0) {
    console.log(`Not in the database (run npm run rooms:import first): ${missing.join(", ")}`);
  }
  console.log(
    `Beds across the listed rooms: ${wantedTotal}` +
      (unlisted.length > 0
        ? ` (+${unlisted.reduce((sum, room) => sum + room.defaultBedCount, 0)} in unlisted rooms)`
        : "")
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Bed reset failed:", err);
  process.exit(1);
});
