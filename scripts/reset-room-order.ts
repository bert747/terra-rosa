import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { rooms } from "../src/db/schema";
import { TERRA_ROSA_ROOMS } from "../src/lib/room-list";

async function main() {
  const all = await db.select({ id: rooms.id, name: rooms.name }).from(rooms);
  const byName = new Map(all.map((room) => [room.name.trim().toLowerCase(), room]));

  let order = 1;
  for (const wanted of TERRA_ROSA_ROOMS) {
    const match = byName.get(wanted.name.trim().toLowerCase());
    if (!match) continue;
    await db.update(rooms).set({ displayOrder: order }).where(eq(rooms.id, match.id));
    order += 1;
  }

  const wantedNames = new Set(TERRA_ROSA_ROOMS.map((room) => room.name.trim().toLowerCase()));
  for (const extra of all) {
    if (wantedNames.has(extra.name.trim().toLowerCase())) continue;
    await db.update(rooms).set({ displayOrder: order }).where(eq(rooms.id, extra.id));
    order += 1;
  }

  console.log(`Room order reset to PDF list order (${order - 1} rooms).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to reset room order:", err);
    process.exit(1);
  });
