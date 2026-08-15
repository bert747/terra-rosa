import "dotenv/config";
import { db } from "../src/db";
import { beds, bedLocations, bookings, floors, joinedBeds, bedSoloPeriods, rooms } from "../src/db/schema";
import { count } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Nuke-and-pave seed for the physical layout (floors/rooms/beds/placements).
// Deletes every existing floor/room/bed/join/solo-period row and replaces
// them with the exact layout below. Bookings are left alone — any booking on
// a deleted bed is unassigned (bed_id = null) by the FK's ON DELETE SET NULL,
// which this script warns about up front. Re-run any time to reset the dev
// layout back to the canonical list.
// ---------------------------------------------------------------------------

type BedTypeSeed = "Single" | "1.5-bed";

interface RoomSeed {
  name: string;
  beds: BedTypeSeed[];
}

interface FloorSeed {
  name: string;
  rooms: RoomSeed[];
}

const single = (n: number): BedTypeSeed[] => Array(n).fill("Single");

// Real current property layout (replaces the old placeholder dev list).
// Every bed is seeded as a Single for now since the PMS handover data this
// was built from doesn't record bed type (see scripts/import-bookings.ts) —
// re-type individual beds afterward via the beds API once known. Room names
// match scripts/import-bookings.ts's source spreadsheet exactly so imported
// bookings auto-match a room here without needing a ROOM_ALIASES entry.
const LAYOUT: FloorSeed[] = [
  {
    name: "Floor 1",
    rooms: [
      { name: "Ensuite 1", beds: single(4) },
      { name: "Sea 1", beds: single(5) },
      { name: "Courtyard 1", beds: single(5) },
      { name: "Back room", beds: single(2) },
      { name: "Infirmary", beds: single(4) },
      { name: "Ashrami Room", beds: single(6) },
    ],
  },
  {
    name: "Floor 2",
    rooms: [
      { name: "Ensuite 2", beds: single(2) },
      { name: "Sea 2", beds: single(4) },
      { name: "Courtyard 2", beds: single(5) },
      { name: "Dorm 2", beds: single(6) },
    ],
  },
  {
    name: "Monks",
    rooms: [
      { name: "Monk 1", beds: single(4) },
      { name: "Monk 2", beds: single(2) },
      { name: "Monk 3", beds: single(3) },
      { name: "Monk 4", beds: single(3) },
      { name: "Monk 5", beds: single(3) },
      { name: "Monk 6", beds: single(3) },
      { name: "Monk 7", beds: single(5) },
    ],
  },
  {
    name: "Outside",
    rooms: [
      { name: "Close", beds: single(2) },
      { name: "Far", beds: single(3) },
      { name: "Bunker", beds: single(1) },
      { name: "Van / Caravan", beds: single(2) },
      { name: "Guardians", beds: single(7) },
      { name: "Camping", beds: single(20) },
      { name: "Glamping", beds: single(20) },
    ],
  },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const [{ value: bookingCount }] = await db.select({ value: count() }).from(bookings);
  const [{ value: bedCount }] = await db.select({ value: count() }).from(beds);
  if (Number(bedCount) > 0) {
    console.warn(
      `About to delete ${bedCount} existing bed(s) and all floors/rooms/joins/solo-periods. ` +
        `${bookingCount} booking(s) currently exist and any assigned to a deleted bed will become unassigned (bed left blank, not deleted).`
    );
  }

  await db.transaction(async (tx) => {
    // FK-safe delete order: things that reference beds/rooms first.
    await tx.delete(joinedBeds);
    await tx.delete(bedSoloPeriods);
    await tx.delete(bedLocations);
    await tx.delete(beds);
    await tx.delete(rooms);
    await tx.delete(floors);

    const today = todayISO();
    let floorCount = 0;
    let roomCount = 0;
    let bedInsertCount = 0;

    for (const floorSeed of LAYOUT) {
      const [floor] = await tx.insert(floors).values({ name: floorSeed.name }).returning();
      floorCount += 1;

      for (const roomSeed of floorSeed.rooms) {
        const [room] = await tx.insert(rooms).values({ floorId: floor.id, name: roomSeed.name }).returning();
        roomCount += 1;

        for (const bedType of roomSeed.beds) {
          const [bed] = await tx.insert(beds).values({ type: bedType }).returning();
          await tx.insert(bedLocations).values({ bedId: bed.id, roomId: room.id, startDate: today, endDate: null });
          bedInsertCount += 1;
        }
      }
    }

    console.log(`Seeded ${floorCount} floor(s), ${roomCount} room(s), ${bedInsertCount} bed(s).`);
  });

  console.log("Layout seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Layout seed failed:", err);
  process.exit(1);
});
