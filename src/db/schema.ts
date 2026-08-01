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
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  emailIdx: uniqueIndex("users_email_idx").on(table.email),
}));

export const floors = pgTable("floors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

export const rooms = pgTable("rooms", {
  id: serial("id").primaryKey(),
  floorId: integer("floor_id")
    .notNull()
    .references(() => floors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
});

// No roomId here on purpose: a bed exists independently of any room it
// currently sits in. Its current/past rooms live in bedLocations. Beds have
// no name/number — only a type (e.g. "Single", "Double") — the id alone
// distinguishes them for bookings.
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

// bedId is nullable with ON DELETE SET NULL: deleting a bed must never
// delete a booking, it should just unassign it.
export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  guestName: text("guest_name").notNull(),
  arrivalDate: date("arrival_date").notNull(),
  departureDate: date("departure_date").notNull(),
  groupId: text("group_id"),
  bedId: integer("bed_id").references(() => beds.id, { onDelete: "set null" }),
  dietariesTags: jsonb("dietaries_tags"),
}, (table) => ({
  bedIdIdx: index("bookings_bed_id_idx").on(table.bedId),
  groupIdIdx: index("bookings_group_id_idx").on(table.groupId),
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
}));

// Untouched by the nuke-and-pave — events are independent of rooms/bookings.
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  notes: text("notes"),
});

// Also untouched by the nuke-and-pave. Nothing in the app reads/writes this
// any more (the meals feature was removed along with the old booking model
// it depended on) — declared here only so `drizzle-kit push` doesn't think
// it's an orphaned table to drop.
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
export type Bed = typeof beds.$inferSelect;
export type BedLocation = typeof bedLocations.$inferSelect;
export type JoinedBed = typeof joinedBeds.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type EventRow = typeof events.$inferSelect;
