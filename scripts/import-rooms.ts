import "dotenv/config";
import { db } from "../src/db";
import { rooms } from "../src/db/schema";
import { TERRA_ROSA_ROOMS } from "../src/lib/room-list";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Applies the real room list (src/lib/room-list.ts) to a database that already
// has rooms in it — which `npm run db:seed` deliberately refuses to do, since
// it runs on every container boot.
//
// Behaviour, chosen so it can't lose booking history:
//
//   * A room in the list but not the database is INSERTED.
//   * A room in both (matched on name, case-insensitively) has its area and
//     notes updated. Its bed count is left ALONE — if someone has corrected a
//     bed count in the app, re-running this must not stamp our estimate back
//     over their real number. Pass --reset-beds to override that.
//   * A room in the database but not the list is DEACTIVATED, not deleted.
//     Deleting cascades to stay_room_segments and would silently destroy
//     bookings; deactivating just takes it out of the grid, and can be undone
//     with the checkbox on the Rooms page.
//
// Safe to run more than once. Prints exactly what it changed.
//
//   npm run rooms:import
//   npm run rooms:import -- --reset-beds
// ---------------------------------------------------------------------------

const resetBeds = process.argv.includes("--reset-beds");

async function main() {
  const existing = await db.select().from(rooms);
  const byName = new Map(existing.map((r) => [r.name.trim().toLowerCase(), r]));
  const wantedNames = new Set(TERRA_ROSA_ROOMS.map((r) => r.name.trim().toLowerCase()));

  let inserted = 0;
  let updated = 0;

  for (const [index, wanted] of TERRA_ROSA_ROOMS.entries()) {
    const match = byName.get(wanted.name.trim().toLowerCase());

    if (!match) {
      await db.insert(rooms).values({
        name: wanted.name,
        locationOrType: wanted.locationOrType,
        displayOrder: index + 1,
        defaultBedCount: wanted.defaultBedCount,
        notes: wanted.notes ?? null,
        isActive: true,
      });
      inserted++;
      console.log(`+ added    ${wanted.name} (${wanted.locationOrType}, ${wanted.defaultBedCount} beds)`);
      continue;
    }

    const patch: Partial<typeof rooms.$inferInsert> = {
      locationOrType: wanted.locationOrType,
      notes: wanted.notes ?? null,
      isActive: true,
      displayOrder: match.displayOrder ?? index + 1,
    };
    if (resetBeds) patch.defaultBedCount = wanted.defaultBedCount;

    const unchanged =
      match.locationOrType === patch.locationOrType &&
      (match.notes ?? null) === (patch.notes ?? null) &&
      match.isActive === true &&
      match.displayOrder === patch.displayOrder &&
      (!resetBeds || match.defaultBedCount === wanted.defaultBedCount);

    if (unchanged) continue;

    await db.update(rooms).set(patch).where(eq(rooms.id, match.id));
    updated++;
    console.log(
      `~ updated  ${match.name}${resetBeds ? ` (beds ${match.defaultBedCount} -> ${wanted.defaultBedCount})` : ""}`
    );
  }

  let deactivated = 0;
  for (const room of existing) {
    if (wantedNames.has(room.name.trim().toLowerCase())) continue;
    if (!room.isActive) continue;
    await db.update(rooms).set({ isActive: false }).where(eq(rooms.id, room.id));
    deactivated++;
    console.log(`- disabled ${room.name} (not in the room list; bookings kept)`);
  }

  console.log(
    `\nDone: ${inserted} added, ${updated} updated, ${deactivated} deactivated.` +
      (resetBeds ? "" : "\nBed counts of existing rooms were left as they are (--reset-beds to overwrite).")
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Room import failed:", err);
  process.exit(1);
});
