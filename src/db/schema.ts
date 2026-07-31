import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  date,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Terra Rosa — database schema
//
// This mirrors the 8-table relational model from the architecture proposal
// exactly. Kept deliberately simple/flat: no bed-level allocation, no
// microservices, no event bus — just tables and foreign keys.
//
// Two constraints from the proposal are NOT expressed as Postgres CHECK/
// EXCLUDE constraints here because Drizzle's pg-core doesn't have a first
// class API for them. They are applied via raw SQL in the migration
// (see drizzle/0000_.../ after `npm run db:push`, or add manually):
//
//   ALTER TABLE users ADD CONSTRAINT users_role_check
//     CHECK (role IN ('editor', 'viewer'));
//
//   ALTER TABLE bookings ADD CONSTRAINT bookings_type_check
//     CHECK (booking_type IN ('guest', 'resident', 'guardian', 'worker'));
//   ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
//     CHECK (status IN ('confirmed', 'cancelled'));
//
//   CREATE EXTENSION IF NOT EXISTS btree_gist;
//   ALTER TABLE room_capacity_overrides ADD CONSTRAINT no_overlapping_overrides
//     EXCLUDE USING gist (
//       room_id WITH =,
//       daterange(start_date, end_date, '[)') WITH &&
//     );
//
// Application code also validates these in TypeScript (see src/lib/validation.ts)
// so failures surface as friendly errors, not raw Postgres exceptions.
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

export const rooms = pgTable("rooms", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  locationOrType: text("location_or_type"),
  displayOrder: integer("display_order"),
  defaultBedCount: integer("default_bed_count").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
});

export const roomCapacityOverrides = pgTable("room_capacity_overrides", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  bedCount: integer("bed_count").notNull(),
  note: text("note"),
});

export const roomBeds = pgTable("room_beds", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  bedType: text("bed_type", { enum: ["single", "queen", "joined_single_pair"] })
    .notNull()
    .default("single"),
  sortOrder: integer("sort_order").notNull().default(1),
});

export const bookings = pgTable("bookings", {
  id: serial("id").primaryKey(),
  leadGuestName: text("lead_guest_name").notNull(),
  // Contact details for whoever made the booking — the number you ring when
  // something about this stay needs sorting. Individual people on the booking
  // can have their own in booking_guests; this is the default one.
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  guestCount: integer("guest_count").notNull().default(1),
  checkInDate: date("check_in_date").notNull(),
  checkOutDate: date("check_out_date"),
  bookingType: text("booking_type", {
    enum: ["guest", "resident", "guardian", "worker"],
  })
    .notNull()
    .default("guest"),
  countsTowardCapacity: boolean("counts_toward_capacity").notNull().default(true),
  countsTowardMeals: boolean("counts_toward_meals").notNull().default(true),
  status: text("status", { enum: ["draft", "confirmed", "cancelled"] })
    .notNull()
    .default("draft"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One row per named person on a booking. Optional: a booking of 12 can have
// zero, three or twelve of these — guest_count on the booking stays the
// authoritative headcount for occupancy/meal math, and this table only exists
// so individual names and dietary requirements can be recorded where known.
export const bookingGuests = pgTable("booking_guests", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  preferredBed: integer("preferred_bed"),
  dietaryRequirements: text("dietary_requirements"),
  // Optional per-person contact, for parties where individuals booked
  // separately or need reaching directly. Falls back to the booking's
  // contact_phone / contact_email when blank.
  phone: text("phone"),
  email: text("email"),
});

export const stayRoomSegments = pgTable("stay_room_segments", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  roomId: integer("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  guestCount: integer("guest_count").notNull().default(1),
  preferredBed: integer("preferred_bed"),
});

export const guardianPresenceOverrides = pgTable("guardian_presence_overrides", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  isOccupied: boolean("is_occupied").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  notes: text("notes"),
});

export const dailyMealNotes = pgTable("daily_meal_notes", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  dietaryAdjustmentCount: integer("dietary_adjustment_count").notNull().default(0),
  notes: text("notes"),
}, (table) => ({
  dateIdx: uniqueIndex("daily_meal_notes_date_idx").on(table.date),
}));

export const operationalNotes = pgTable("operational_notes", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  roomId: integer("room_id").references(() => rooms.id, { onDelete: "cascade" }),
  bookingId: integer("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
  noteText: text("note_text").notNull(),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations (used for Drizzle's relational query API, e.g. db.query.bookings.findMany
// with `with: { segments: true }`)
// ---------------------------------------------------------------------------

export const roomsRelations = relations(rooms, ({ many }) => ({
  capacityOverrides: many(roomCapacityOverrides),
  roomBeds: many(roomBeds),
  segments: many(stayRoomSegments),
  operationalNotes: many(operationalNotes),
}));

export const roomCapacityOverridesRelations = relations(roomCapacityOverrides, ({ one }) => ({
  room: one(rooms, { fields: [roomCapacityOverrides.roomId], references: [rooms.id] }),
}));

export const roomBedsRelations = relations(roomBeds, ({ one }) => ({
  room: one(rooms, { fields: [roomBeds.roomId], references: [rooms.id] }),
}));

export const bookingsRelations = relations(bookings, ({ many, one }) => ({
  segments: many(stayRoomSegments),
  guests: many(bookingGuests),
  guardianPresenceOverrides: many(guardianPresenceOverrides),
  operationalNotes: many(operationalNotes),
  createdByUser: one(users, { fields: [bookings.createdBy], references: [users.id] }),
}));

export const guardianPresenceOverridesRelations = relations(guardianPresenceOverrides, ({ one }) => ({
  booking: one(bookings, { fields: [guardianPresenceOverrides.bookingId], references: [bookings.id] }),
}));

export const bookingGuestsRelations = relations(bookingGuests, ({ one }) => ({
  booking: one(bookings, { fields: [bookingGuests.bookingId], references: [bookings.id] }),
}));

export const stayRoomSegmentsRelations = relations(stayRoomSegments, ({ one }) => ({
  booking: one(bookings, { fields: [stayRoomSegments.bookingId], references: [bookings.id] }),
  room: one(rooms, { fields: [stayRoomSegments.roomId], references: [rooms.id] }),
}));

export const operationalNotesRelations = relations(operationalNotes, ({ one }) => ({
  room: one(rooms, { fields: [operationalNotes.roomId], references: [rooms.id] }),
  booking: one(bookings, { fields: [operationalNotes.bookingId], references: [bookings.id] }),
  createdByUser: one(users, { fields: [operationalNotes.createdBy], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  bookingsCreated: many(bookings),
  operationalNotesCreated: many(operationalNotes),
}));

export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RoomCapacityOverride = typeof roomCapacityOverrides.$inferSelect;
export type RoomBed = typeof roomBeds.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type BookingGuest = typeof bookingGuests.$inferSelect;
export type StayRoomSegment = typeof stayRoomSegments.$inferSelect;
export type GuardianPresenceOverride = typeof guardianPresenceOverrides.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type DailyMealNote = typeof dailyMealNotes.$inferSelect;
export type OperationalNote = typeof operationalNotes.$inferSelect;
