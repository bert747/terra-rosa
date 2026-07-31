import "dotenv/config";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { hashPassword } from "../src/lib/auth";

// ---------------------------------------------------------------------------
// Create a single user. Unlike scripts/seed.ts (which only ever creates the
// very first user, when the table is empty), this is the way to add accounts
// after that — there is no signup route or user-admin page by design.
//
//   npm run user:create -- --name "Jo" --email jo@example.com --role viewer
//
// Password is read from the CREATE_USER_PASSWORD env var, not a flag, so it
// doesn't end up in your shell history:
//
//   CREATE_USER_PASSWORD='...' npm run user:create -- --name ... --email ...
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const name = flag("name");
  const email = flag("email")?.trim().toLowerCase();
  const role = flag("role") ?? "editor";
  const password = process.env.CREATE_USER_PASSWORD;

  if (!name || !email || !password) {
    console.error(
      "Usage: CREATE_USER_PASSWORD='...' npm run user:create -- " +
        "--name <name> --email <email> [--role editor|viewer]"
    );
    process.exit(1);
  }

  if (role !== "editor" && role !== "viewer") {
    console.error(`Invalid role "${role}" — must be "editor" or "viewer".`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  try {
    const [created] = await db
      .insert(users)
      .values({ name, email, passwordHash, role })
      .returning({ id: users.id, email: users.email, role: users.role });
    console.log(`Created user ${created.id}: ${created.email} (${created.role})`);
  } catch (err) {
    // users_email_idx is a unique index, so a duplicate email lands here as
    // Postgres error 23505. Drizzle wraps the driver error, so check `cause`
    // as well as the error itself.
    const code = (err as { code?: string })?.code
      ?? ((err as { cause?: { code?: string } })?.cause)?.code;
    if (code === "23505") {
      console.error(`A user with email ${email} already exists.`);
      process.exit(1);
    }
    throw err;
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to create user:", err);
  process.exit(1);
});
