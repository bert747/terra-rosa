import "dotenv/config";
import { db } from "../src/db";
import { bedTypes, users } from "../src/db/schema";
import { hashPassword } from "../src/lib/auth";
import { count } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Idempotent baseline seed: only creates the admin user if the users table is
// currently empty, so it's safe to run on every container start. Floors,
// rooms and beds are no longer seeded from a hardcoded list — set them up in
// the Property Layout settings page (/settings/layout). The two starting
// bed types (Single/1.5-bed) ARE seeded here, same as the admin user, since
// without at least one type the "Add Bed" flow on that page has nothing to
// offer — further types are then added from the page itself.
// ---------------------------------------------------------------------------

async function main() {
  const [{ value: bedTypeCount }] = await db.select({ value: count() }).from(bedTypes);
  if (Number(bedTypeCount) === 0) {
    console.log("Seeding starting bed types: Single (sleeps 1), 1.5-bed (sleeps 2)");
    await db.insert(bedTypes).values([
      { name: "Single", capacity: 1 },
      { name: "1.5-bed", capacity: 2 },
    ]);
  } else {
    console.log(`bed_types table already has ${bedTypeCount} row(s) — skipping bed type seed.`);
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
