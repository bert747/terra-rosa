import "dotenv/config";
import * as XLSX from "xlsx";
import { db } from "../src/db";
import { bookings, rooms, guestCategories } from "../src/db/schema";
import { count, eq } from "drizzle-orm";
import { findAvailableBeds } from "../src/lib/available-beds";

// ---------------------------------------------------------------------------
// One-off bulk import of historical bookings from the PMS handover
// spreadsheet's "PMS Upload" sheet (Booking ID / Split Booking / Guest Name /
// Arrival Date / Departure Date / Guest Type / Bedroom columns). Run once
// against the server's database:
//
//   npx tsx scripts/import-bookings.ts /path/to/PMS_Upload_Final.xlsx
//
// The sheet only names a ROOM per booking, not a specific bed, so this
// auto-assigns the first free bed in that room for the guest's date range —
// the exact same logic (findAvailableBeds) the app itself uses when staff
// place a booking. A guest whose room can't be matched, or whose room has no
// free bed left for those dates, is still inserted with bedId = null rather
// than dropped — the app's existing "Unassigned" alert already surfaces
// those for manual fixing, so nothing new needs to be built to catch them.
//
// "Split Booking" chains (one guest's stay broken into pieces on different
// beds/rooms, each row naming the PREVIOUS chunk's Booking ID) are wired up
// into this app's own splitGroupId lineage after every row is inserted, so
// the grid's "jump to other part" / "Merge" links work exactly as if staff
// had split the booking by hand.
//
// Uses the `xlsx` package (not exceljs) because the real handover file is
// produced by a non-Excel tool with unusually-namespaced-but-valid OOXML
// that exceljs's stricter parser refuses to open. `xlsx` only ever reads a
// file you created and reviewed yourself, never attacker-supplied input.
// ---------------------------------------------------------------------------

// Sheet value -> this app's guest_categories.name. "Retreat" assumes you've
// renamed the seeded "Resident" category to "Retreat" (Settings > Layout)
// before running this — rename it back here instead if you haven't.
const GUEST_TYPE_MAP: Record<string, string> = {
  "F&F": "Friends & Family",
  Guest: "Guest",
  Ashram: "Ashrami",
  Retreat: "Retreat",
};

// Fill in only if a sheet room name doesn't match (case aside) a room name
// already in Settings > Layout, e.g. { "Van / Caravan": "Caravan" }.
const ROOM_ALIASES: Record<string, string> = {};

function excelSerialToISODate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
}

interface SheetRow {
  "Booking ID"?: string | number;
  "Split Booking"?: string | number;
  "Guest Name"?: string;
  "Arrival Date"?: number | string;
  "Departure Date"?: number | string;
  "Guest Type"?: string;
  Bedroom?: string;
}

interface SourceRow {
  bookingId: string;
  splitFrom: string | null;
  guestName: string;
  arrivalDate: string;
  departureDate: string;
  guestTypeRaw: string;
  roomNameRaw: string;
  rowNum: number;
}

function asDate(value: number | string | undefined, rowNum: number, field: string): string {
  if (typeof value === "number") return excelSerialToISODate(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  throw new Error(`Unreadable ${field} in row ${rowNum}: ${JSON.stringify(value)}`);
}

async function main() {
  const filePath = process.argv[2];
  const force = process.argv.includes("--force");
  if (!filePath) {
    console.error("Usage: npx tsx scripts/import-bookings.ts <path-to-xlsx> [--force]");
    process.exit(1);
  }

  const [{ value: existingBookings }] = await db.select({ value: count() }).from(bookings);
  if (Number(existingBookings) > 0 && !force) {
    console.error(
      `bookings table already has ${existingBookings} row(s) — refusing to import on top of existing data ` +
        `(this script doesn't dedupe against what's already there). Pass --force to import anyway.`
    );
    process.exit(1);
  }

  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets["PMS Upload"];
  if (!sheet) {
    console.error(`No "PMS Upload" sheet found in ${filePath}`);
    process.exit(1);
  }

  const rawRows = XLSX.utils.sheet_to_json<SheetRow>(sheet, { raw: true, defval: "" });

  const sourceRows: SourceRow[] = [];
  rawRows.forEach((raw, i) => {
    const rowNum = i + 2; // header is row 1
    const bookingId = String(raw["Booking ID"] ?? "").trim();
    if (!bookingId) return; // blank trailing row
    sourceRows.push({
      bookingId,
      splitFrom: String(raw["Split Booking"] ?? "").trim() || null,
      guestName: String(raw["Guest Name"] ?? "").trim(),
      arrivalDate: asDate(raw["Arrival Date"], rowNum, "Arrival Date"),
      departureDate: asDate(raw["Departure Date"], rowNum, "Departure Date"),
      guestTypeRaw: String(raw["Guest Type"] ?? "").trim(),
      roomNameRaw: String(raw["Bedroom"] ?? "").trim(),
      rowNum,
    });
  });

  console.log(`Parsed ${sourceRows.length} booking row(s) from "${filePath}".`);

  const allRooms = await db.select().from(rooms);
  const roomByName = new Map(allRooms.map((r) => [r.name.trim().toLowerCase(), r]));
  const allCategories = await db.select().from(guestCategories);
  const categoryByName = new Map(allCategories.map((c) => [c.name.trim().toLowerCase(), c]));

  const findRoom = (rawName: string) => {
    const alias = ROOM_ALIASES[rawName] ?? rawName;
    return roomByName.get(alias.trim().toLowerCase()) ?? null;
  };

  const idToDbId = new Map<string, number>();
  const predecessorOf = new Map<string, string>();
  const unknownRooms = new Map<string, number[]>();
  const unknownGuestTypes = new Map<string, number[]>();
  const noFreeBed: { room: string; rowNum: number }[] = [];
  const badDateOrder: { bookingId: string; rowNum: number }[] = [];
  let inserted = 0;

  for (const row of sourceRows) {
    if (row.splitFrom) predecessorOf.set(row.bookingId, row.splitFrom);

    // A same-day (or reversed) arrival/departure is invalid data the app's
    // own booking form would reject — don't guess a real departure date,
    // just skip the row and report it for a manual fix.
    if (row.departureDate <= row.arrivalDate) {
      badDateOrder.push({ bookingId: row.bookingId, rowNum: row.rowNum });
      continue;
    }

    let bedId: number | null = null;
    const room = findRoom(row.roomNameRaw);
    if (!room) {
      unknownRooms.set(row.roomNameRaw, [...(unknownRooms.get(row.roomNameRaw) ?? []), row.rowNum]);
    } else {
      const available = await findAvailableBeds({
        arrivalDate: row.arrivalDate,
        departureDate: row.departureDate,
        nearRoomId: room.id,
      });
      if (available.length > 0) {
        bedId = available[0].id;
      } else {
        noFreeBed.push({ room: room.name, rowNum: row.rowNum });
      }
    }

    let guestCategoryId: number | null = null;
    if (row.guestTypeRaw) {
      const mappedName = GUEST_TYPE_MAP[row.guestTypeRaw];
      const category = mappedName ? categoryByName.get(mappedName.toLowerCase()) : undefined;
      if (category) {
        guestCategoryId = category.id;
      } else {
        unknownGuestTypes.set(row.guestTypeRaw, [...(unknownGuestTypes.get(row.guestTypeRaw) ?? []), row.rowNum]);
      }
    }

    const firstSpace = row.guestName.indexOf(" ");
    const firstName = firstSpace === -1 ? row.guestName : row.guestName.slice(0, firstSpace);
    const lastName = firstSpace === -1 ? "" : row.guestName.slice(firstSpace + 1).trim();

    const [created] = await db
      .insert(bookings)
      .values({
        guestName: row.guestName,
        firstName,
        lastName,
        arrivalDate: row.arrivalDate,
        departureDate: row.departureDate,
        bedId,
        guestCategoryId,
        notes: `Imported from PMS upload, booking #${row.bookingId}`,
      })
      .returning({ id: bookings.id });

    idToDbId.set(row.bookingId, created.id);
    inserted += 1;
  }

  // Walk each row's predecessor chain back to its ultimate root, then group
  // every row by that root — same lineage rule bookings.splitGroupId itself
  // documents (schema.ts): every descendant of one original split-into-
  // pieces stay shares the root's own booking id, including the root once
  // it's actually been split.
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (predecessorOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = predecessorOf.get(current)!;
    }
    return current;
  };

  const chainMembers = new Map<string, string[]>();
  for (const row of sourceRows) {
    const root = rootOf(row.bookingId);
    chainMembers.set(root, [...(chainMembers.get(root) ?? []), row.bookingId]);
  }

  let splitGroupsLinked = 0;
  for (const [root, members] of chainMembers) {
    if (members.length <= 1) continue;
    const rootDbId = idToDbId.get(root);
    if (!rootDbId) continue;
    for (const memberId of members) {
      const dbId = idToDbId.get(memberId);
      if (!dbId) continue;
      await db.update(bookings).set({ splitGroupId: rootDbId }).where(eq(bookings.id, dbId));
    }
    splitGroupsLinked += 1;
  }

  console.log(`\nInserted ${inserted} booking(s). Linked ${splitGroupsLinked} split chain(s).`);

  if (badDateOrder.length > 0) {
    console.log(`\nSkipped ${badDateOrder.length} booking(s) with departure <= arrival (not inserted — fix the dates and add manually):`);
    for (const { bookingId, rowNum } of badDateOrder) console.log(`  Booking #${bookingId} — row ${rowNum}`);
  }
  if (unknownRooms.size > 0) {
    console.log(`\nRoom name(s) not found in the database — inserted unassigned (fix the room in the app, or add a ROOM_ALIASES entry above and re-run with --force):`);
    for (const [name, rowNums] of unknownRooms) console.log(`  "${name}" — row(s) ${rowNums.join(", ")}`);
  }
  if (unknownGuestTypes.size > 0) {
    console.log(`\nGuest type value(s) not recognised — inserted with no guest type set:`);
    for (const [name, rowNums] of unknownGuestTypes) console.log(`  "${name}" — row(s) ${rowNums.join(", ")}`);
  }
  if (noFreeBed.length > 0) {
    console.log(`\nNo free bed left in the named room for ${noFreeBed.length} booking(s) — inserted unassigned, will show in the app's Alerts panel:`);
    for (const { room, rowNum } of noFreeBed) console.log(`  row ${rowNum} — ${room}`);
  }

  console.log("\nImport complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
