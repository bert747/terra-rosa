import "dotenv/config";
import { db } from "../src/db";
import { rooms, users } from "../src/db/schema";
import { hashPassword } from "../src/lib/auth";
import { TERRA_ROSA_ROOMS } from "../src/lib/room-list";
import { count } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Idempotent baseline seed: only inserts rooms/admin user if the tables are
// currently empty, so it's safe to run on every container start.
//
// The room list itself lives in src/lib/room-list.ts (transcribed from the
// occupancy spreadsheet). To apply it to a database that already has rooms in
// it — e.g. one seeded with the old "Room 1..20" placeholders — this script
// won't touch anything; run `npm run rooms:import` instead.
// ---------------------------------------------------------------------------

async function main() {
  const [{ value: roomCount }] = await db.select({ value: count() }).from(rooms);
  if (Number(roomCount) === 0) {
    console.log(`Seeding ${TERRA_ROSA_ROOMS.length} rooms...`);
    await db.insert(rooms).values(
      TERRA_ROSA_ROOMS.map((r, i) => ({
        name: r.name,
        locationOrType: r.locationOrType,
        displayOrder: i + 1,
        defaultBedCount: r.defaultBedCount,
        notes: r.notes ?? null,
        isActive: true,
      }))
    );
  } else {
    console.log(`Rooms table already has ${roomCount} row(s) — skipping room seed.`);
  }

  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  if (Number(userCount) === 0) {
    const name = process.env.SEED_ADMIN_NAME ?? "Admin";
    // Lowercased to match the login route, which lowercases what the user
    // types before looking the email up — a seeded address with capitals
    // would otherwise never match and could never log in.
    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;

    if (!email || !password) {
      console.warn(
        "SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipping admin user creation. " +
          "Set them in .env and re-run `npm run db:seed`."
      );
    } else {
      console.log(`Creating first admin user: ${email}`);
      const passwordHash = await hashPassword(password);
      await db.insert(users).values({ name, email, passwordHash, role: "editor" });
    }
  } else {
    console.log(`Users table already has ${userCount} row(s) — skipping admin seed.`);
  }

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
