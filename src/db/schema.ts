import {
  pgTable,
  serial,
  text,
  integer,
  date,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Terra Rosa — database schema
//
// Nuke-and-pave rebuild (see drizzle/0001_nuke_and_pave.sql). Physical layout
// (floors/rooms/beds/bed_locations/joined_beds) is entirely independent of
// bookings: a bed can move rooms, or be joined with another bed into a
// double, regardless of whether it currently has a booking. `users` is
// unchanged from the previous schema.
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["editor", "viewer"] })
    .notNull()
    .default("editor"),
  // Set whenever an editor resets someone's password to a server-generated
  // temporary one (see POST /api/users/[id]/reset-password) — forces that
  // user through /change-password on their next login before they can reach
  // anywhere else, then gets cleared. Never set for a normal self-chosen
  // password change.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  emailIdx: uniqueIndex("users_email_idx").on(table.email),
}));

export const floors = pgTable("floors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

// A named group of "interchangeable" rooms (e.g. "Courtyard & Sea Rooms",
// "Monks Rooms") — see src/lib/allocation-fixes.ts, which only ever
// proposes moving a booking into another room in the SAME category as a
// fix/move suggestion. `rank` is a plain manually-set sort order (lower =
// more premium), edited by drag-to-reorder in Layout settings — nothing
// here computes it automatically, since the actual premium-ness ordering
// is a judgement call for the property owners, not something this app can
// infer from room names/sizes. Deliberately a flat, always-current
// assignment (a room belongs to at most one category, right now) rather
// than date-scoped — see that same file's own note on why: real premium
// events do temporarily change which rooms are interchangeable, but that's
// handled today by manually re-pointing a room's category before/after the
// event, the same way every other layout change in this app already works,
// rather than adding a second date-scoped history table on top of this one.
export const roomCategories = pgTable("room_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  rank: integer("rank").notNull().default(0),
});

// The admin-editable list of guest types (e.g. "Resident", "Ashrami",
// "Guest") a booking can be tagged with — drives both the grid pill's
// colour and the guest-type dropdown on the booking form. `active` is a
// soft-delete flag rather than a real row delete: "deleting" a category
// from Layout settings should stop it being offered for NEW bookings
// without touching the colour/label on any EXISTING booking still
// referencing it (bookings.guestCategoryId keeps pointing at the row).
export const guestCategories = pgTable("guest_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // A CSS colour (hex) used for both the grid pill's fill and its border —
  // see --tr-booking-color/--tr-booking-fill in globals.css for the single
  // hardcoded colour this replaces.
  colour: text("colour").notNull(),
  rank: integer("rank").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

export const rooms = pgTable("rooms", {
  id: serial("id").primaryKey(),
  floorId: integer("floor_id")
    .notNull()
    .references(() => floors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // True only for the system-managed "Dorm Storage" room (see
  // src/lib/dorm-storage.ts) — a bed parked there is off active duty and
  // must yield 0 toward house capacity. capacityByDate() in src/lib/grid.ts
  // skips any room with this set; the /settings/layout page also hides it,
  // since it isn't part of the user-managed physical layout.
  excludeFromCapacity: boolean("exclude_from_capacity").notNull().default(false),
  // Which "interchangeable rooms" group this room belongs to, if any — null
  // means genuinely one-of-a-kind (never offered as a swap for anything,
  // never has anything swapped in for it either). See roomCategories above.
  categoryId: integer("category_id").references((): AnyPgColumn => roomCategories.id, { onDelete: "set null" }),
  // Never offered as a Fix/move-suggestion target, full stop, regardless of
  // category — the owner's own room, the chef's room, the caravan, and (for
  // now — see the "Friends & Family" guest category) the rooms only ever
  // used for friends & family guests, which staff still place by hand.
  excludeFromSuggestions: boolean("exclude_from_suggestions").notNull().default(false),
  // Manual display order within a floor (lower = earlier), drag-to-reorder
  // in Layout settings — same pattern as roomCategories.rank above. Every
  // room defaults to 0, so until someone actually drags a row, sortRooms()
  // falls through to its natural-name tiebreak and nothing changes.
  rank: integer("rank").notNull().default(0),
});

// The catalogue of bed types staff can add inventory of — managed from
// /settings/layout. capacity is how many guests a bed of this type sleeps
// (1 for a Single, 2 for a native two-person bed like a 1.5-bed/Double/
// Queen) — see src/lib/bed-types.ts, the single place this drives grid
// occupancy/capacity math.
export const bedTypes = pgTable("bed_types", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  capacity: integer("capacity").notNull().default(1),
}, (table) => ({
  nameIdx: uniqueIndex("bed_types_name_idx").on(table.name),
}));

// No roomId here on purpose: a bed exists independently of any room it
// currently sits in. Its current/past rooms live in bedLocations. Beds have
// no name/number — only a type (e.g. "Single", "Double") — the id alone
// distinguishes them for bookings. `type` is a plain text column (not an FK)
// so an existing bed's type never breaks if its bedTypes row is renamed;
// isKnownBedType() in bed-types.ts is what actually enforces new beds only
// ever get a currently-known type name.
export const beds = pgTable("beds", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
});

// One row per stint a bed spends in a room. endDate null = currently there.
export const bedLocations = pgTable("bed_locations", {
  id: serial("id").primaryKey(),
  bedId: integer("bed_id")
    .notNull()
    .references(() => beds.id, { onDelete: "cascade" }),
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
}, (table) => ({
  bedIdIdx: index("bed_locations_bed_id_idx").on(table.bedId),
  roomIdIdx: index("bed_locations_room_id_idx").on(table.roomId),
}));

// Two single beds pushed together to form a double, for some date range.
// endDate null = ongoing (no scheduled split yet). "double" sleeps 2 and
// counts as capacity 2; "solo" is pushed together for comfort/space but sold
// as a single spot, capacity 1.
export const joinedBeds = pgTable("joined_beds", {
  id: serial("id").primaryKey(),
  bed1Id: integer("bed_1_id")
    .notNull()
    .references(() => beds.id, { onDelete: "cascade" }),
  bed2Id: integer("bed_2_id")
    .notNull()
    .references(() => beds.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  mode: text("mode", { enum: ["double", "solo"] }).notNull().default("double"),
}, (table) => ({
  bed1IdIdx: index("joined_beds_bed_1_id_idx").on(table.bed1Id),
  bed2IdIdx: index("joined_beds_bed_2_id_idx").on(table.bed2Id),
}));

// A native two-person bed (Queen, 1.5, Double — see bed-types.ts) sleeps 2
// and shows as 2 rows by default ("couple"). A covering row here means it's
// sold as one spot instead for that range ("solo") — the second row merges
// into the first. endDate null = ongoing (no scheduled switch back yet).
export const bedSoloPeriods = pgTable("bed_solo_periods", {
  id: serial("id").primaryKey(),
  bedId: integer("bed_id")
    .notNull()
    .references(() => beds.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
}, (table) => ({
  bedIdIdx: index("bed_solo_periods_bed_id_idx").on(table.bedId),
}));

// bedId is nullable with ON DELETE SET NULL: deleting a bed must never
// delete a booking, it should just unassign it.
// linkedBookingId is a self-reference ("Sleeps near / Linked with") — ON
// DELETE SET NULL so deleting the linked-to booking just unlinks this one
// rather than cascading. Deliberately one-directional (not a join table):
// the UI only ever asks "who is THIS guest sleeping near", so a single
// nullable FK on the booking that's doing the linking is enough — it does
// NOT imply the reverse booking links back.
// sharesBedWithBookingId is a SYMMETRIC pairing ("Shares Bed With" / coupled
// allocation) — unlike linkedBookingId ("Sleeps near", one-directional hint
// only), both bookings in a couple point at each other so either side can be
// followed to find its partner and the joined_beds row backing the double.
// splitGroupId identifies a split lineage: every booking descended from the
// same original split-into-pieces stay shares the SAME value, which is the
// id of the very first (root) booking in that lineage — including the root
// itself, once it's been split at least once (see POST /api/bookings/[id]/
// split). A plain, never-split booking has this null. This is what lets the
// grid pill/booking-edit-page "jump to the other part" arrows and "Merge"
// find every sibling with one query (`WHERE split_group_id = X`) instead of
// guessing from guest name + adjacent dates.
// A reusable guest profile — lets a returning guest's dietary info (the
// main motivating case, see guests.dietariesTags) get pulled onto a NEW
// booking instead of re-typing it, and stay current: editing dietary on any
// booking linked to a guest updates this row, which every OTHER booking
// linked to the same guest then reads through bookings.guestId (see that
// column's own comment for the "kept in sync onto the booking row too"
// mechanics). Deliberately opt-in, not automatic — existing bookings are
// never retroactively matched into a guest profile; staff link one
// explicitly (search-existing or "save as a new profile") from the booking
// form when they actually want to.
export const guests = pgTable("guests", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  preferredName: text("preferred_name"),
  dietariesTags: jsonb("dietaries_tags"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  // The record of truth everywhere EXCEPT the grid pill and the booking
  // form itself (bookings list, exports, daily sheet, allocation-issue
  // text, "Shares Bed With" pickers, …) — kept automatically in sync as
  // `${firstName} ${lastName}`.trim() by the bookings API whenever either
  // of those changes, so every one of those call sites keeps working
  // unchanged rather than needing to be taught about the two new fields.
  guestName: text("guest_name").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  // Optional short/preferred form of firstName — used ONLY to pick what the
  // grid pill shows (see pillDisplayName in GridCanvas.tsx), since a first
  // name is sometimes not what someone actually goes by.
  preferredName: text("preferred_name"),
  arrivalDate: date("arrival_date").notNull(),
  departureDate: date("departure_date").notNull(),
  linkedBookingId: integer("linked_booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
  sharesBedWithBookingId: integer("shares_bed_with_booking_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
  splitGroupId: integer("split_group_id").references((): AnyPgColumn => bookings.id, { onDelete: "set null" }),
  bedId: integer("bed_id").references(() => beds.id, { onDelete: "set null" }),
  dietariesTags: jsonb("dietaries_tags"),
  // Which reusable guest profile (if any) this booking is linked to — see
  // guests' own comment. Null for the vast majority of bookings (nothing
  // retroactive, nothing forced); when set, the booking API keeps this
  // row's own firstName/lastName/preferredName/dietariesTags mirroring the
  // guest's, so every existing reader of THOSE columns (grid pill, bookings
  // list, exports, …) keeps working unchanged — the linkage only changes
  // what happens when the booking form is next saved.
  guestId: integer("guest_id").references(() => guests.id, { onDelete: "set null" }),
  // Nullable on purpose — a future bulk-imported booking may arrive with no
  // known guest type at all, needing manual assignment afterward rather
  // than being forced into a fake default. See guestCategories above.
  guestCategoryId: integer("guest_category_id").references((): AnyPgColumn => guestCategories.id, { onDelete: "set null" }),
  // A free-text staff note, surfaced on the grid pill as a small folded-
  // corner marker (like an Excel cell comment) rather than always-visible
  // text — for anything worth flagging on a specific booking (a request, a
  // quirk, a heads-up for the next shift) that doesn't belong in any of the
  // other structured fields.
  notes: text("notes"),
}, (table) => ({
  bedIdIdx: index("bookings_bed_id_idx").on(table.bedId),
  linkedBookingIdIdx: index("bookings_linked_booking_id_idx").on(table.linkedBookingId),
  sharesBedWithBookingIdIdx: index("bookings_shares_bed_with_booking_id_idx").on(table.sharesBedWithBookingId),
  splitGroupIdIdx: index("bookings_split_group_id_idx").on(table.splitGroupId),
}));

// A running audit trail of who changed what, when — see src/lib/change-log.ts
// (the one place that writes to this table) and app/history/page.tsx (the
// one place that reads it). Deliberately a flat, append-only log of short
// human-readable summaries rather than a full before/after diff engine —
// enough to answer "who moved this and when" without needing to reconstruct
// or replay state. `userName`/`entityLabel` are snapshotted at write time
// (not just an id) so an entry still reads correctly after the user account
// or the booking/room/etc. it refers to is later renamed or deleted.
export const changeLogEntries = pgTable("change_log_entries", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  userName: text("user_name").notNull(),
  // Which top-level area this change belongs to — drives the /history page's
  // own filter dropdown. Deliberately coarse (not one category per table).
  category: text("category", { enum: ["grid", "bookings", "events", "layout"] }).notNull(),
  // Short verb phrase for the list ("Moved bed", "Created booking", …) plus
  // a fuller one-line summary with the actual names/dates involved.
  action: text("action").notNull(),
  summary: text("summary").notNull(),
}, (table) => ({
  createdAtIdx: index("change_log_entries_created_at_idx").on(table.createdAt),
  categoryIdx: index("change_log_entries_category_idx").on(table.category),
}));

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const floorsRelations = relations(floors, ({ many }) => ({
  rooms: many(rooms),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  floor: one(floors, { fields: [rooms.floorId], references: [floors.id] }),
  bedLocations: many(bedLocations),
}));

export const bedsRelations = relations(beds, ({ many }) => ({
  locations: many(bedLocations),
  bookings: many(bookings),
  joinedAsBed1: many(joinedBeds, { relationName: "bed1" }),
  joinedAsBed2: many(joinedBeds, { relationName: "bed2" }),
}));

export const bedLocationsRelations = relations(bedLocations, ({ one }) => ({
  bed: one(beds, { fields: [bedLocations.bedId], references: [beds.id] }),
  room: one(rooms, { fields: [bedLocations.roomId], references: [rooms.id] }),
}));

export const joinedBedsRelations = relations(joinedBeds, ({ one }) => ({
  bed1: one(beds, { fields: [joinedBeds.bed1Id], references: [beds.id], relationName: "bed1" }),
  bed2: one(beds, { fields: [joinedBeds.bed2Id], references: [beds.id], relationName: "bed2" }),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  bed: one(beds, { fields: [bookings.bedId], references: [beds.id] }),
  linkedBooking: one(bookings, {
    fields: [bookings.linkedBookingId],
    references: [bookings.id],
    relationName: "linkedBooking",
  }),
  sharesBedWithBooking: one(bookings, {
    fields: [bookings.sharesBedWithBookingId],
    references: [bookings.id],
    relationName: "sharesBedWithBooking",
  }),
}));

// Untouched by the nuke-and-pave — events are independent of rooms/bookings.
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  notes: text("notes"),
  // Nullable — an event created before this existed (or one nobody's
  // bothered to colour yet) falls back to the old hash-based auto-pick from
  // EVENT_PALETTE (see src/lib/room-colours.ts's eventColour), so nothing
  // needs backfilling.
  colour: text("colour"),
});

// One free-text note per calendar date, for manual overrides on the Meals
// section of the Daily Sheet (see app/daily-sheet) — e.g. "extra 2 covers
// for a walk-in guest"
// that the computed guest/dietary counts can't know about on their own.
// dietaryAdjustmentCount is a leftover from an earlier, removed meals
// feature — nothing writes it any more, kept only so `drizzle-kit push`
// doesn't treat the column as orphaned and drop it.
export const dailyMealNotes = pgTable("daily_meal_notes", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  dietaryAdjustmentCount: integer("dietary_adjustment_count").notNull().default(0),
  notes: text("notes"),
}, (table) => ({
  dateIdx: uniqueIndex("daily_meal_notes_date_idx").on(table.date),
}));

export const usersRelations = relations(users, () => ({}));

export type User = typeof users.$inferSelect;
export type Floor = typeof floors.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type BedType = typeof bedTypes.$inferSelect;
export type Bed = typeof beds.$inferSelect;
export type BedLocation = typeof bedLocations.$inferSelect;
export type JoinedBed = typeof joinedBeds.$inferSelect;
export type BedSoloPeriod = typeof bedSoloPeriods.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type EventRow = typeof events.$inferSelect;
