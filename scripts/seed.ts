import "dotenv/config";
import { db } from "../src/db";
import { bedTypes, users, guestCategories } from "../src/db/schema";
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

  const [{ value: guestCategoryCount }] = await db.select({ value: count() }).from(guestCategories);
  if (Number(guestCategoryCount) === 0) {
    // Starting set mirrors the four guest types this replaced (see
    // guestCategories' own schema comment) — colours are just a distinct
    // starting palette, freely re-editable from Layout settings afterward.
    console.log("Seeding starting guest categories: Guest, Resident, Ashrami, Friends & Family");
    await db.insert(guestCategories).values([
      { name: "Guest", colour: "#8a7360", rank: 0 },
      { name: "Resident", colour: "#4b7a5e", rank: 1 },
      { name: "Ashrami", colour: "#8a5a8a", rank: 2 },
      { name: "Friends & Family", colour: "#5a7a9a", rank: 3 },
    ]);
  } else {
    console.log(`guest_categories table already has ${guestCategoryCount} row(s) — skipping guest category seed.`);
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
