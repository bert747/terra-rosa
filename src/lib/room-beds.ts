import { asc, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { roomBeds, rooms } from "@/db/schema";

export const BED_TYPE_LABELS = {
  single: "single",
  queen: "queen",
  joined_single_pair: "2 singles together",
} as const;

export type BedType = keyof typeof BED_TYPE_LABELS;

/** A joined pair is one room_beds row but counts as two beds; everything else counts as one. */
export function bedCapacity(bedType: BedType): number {
  return bedType === "joined_single_pair" ? 2 : 1;
}

export function sumBedCapacity(beds: Array<{ bedType: BedType }>): number {
  return beds.reduce((sum, bed) => sum + bedCapacity(bed.bedType), 0);
}

export async function ensureRoomBedsSeeded() {
  const [{ value }] = await db.select({ value: count() }).from(roomBeds);
  if (Number(value) > 0) return;

  const allRooms = await db.select().from(rooms).where(eq(rooms.isActive, true));
  for (const room of allRooms) {
    if (room.defaultBedCount <= 0) continue;
    await db.insert(roomBeds).values(
      Array.from({ length: room.defaultBedCount }, (_, index) => ({
        roomId: room.id,
        bedType: "single" as const,
        sortOrder: index + 1,
      }))
    );
  }
}

export async function syncRoomBedCount(roomId: number) {
  const [{ value }] = await db
    .select({ value: count() })
    .from(roomBeds)
    .where(eq(roomBeds.roomId, roomId));

  await db
    .update(rooms)
    .set({ defaultBedCount: Number(value ?? 0) })
    .where(eq(rooms.id, roomId));
}

export async function nextRoomBedSortOrder(roomId: number): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`COALESCE(MAX(${roomBeds.sortOrder}), 0)` })
    .from(roomBeds)
    .where(eq(roomBeds.roomId, roomId));
  return Number(row?.value ?? 0) + 1;
}

export async function roomBedsForRoom(roomId: number) {
  return db
    .select()
    .from(roomBeds)
    .where(eq(roomBeds.roomId, roomId))
    .orderBy(asc(roomBeds.sortOrder), asc(roomBeds.id));
}

/**
 * Rewrites a room's bed rows to reach `targetCount` beds of capacity, adding
 * plain singles or removing the highest-sort-order rows first — mirrors the
 * diffing the Rooms page does when a room's bed count is edited directly.
 */
export async function setRoomBedCount(roomId: number, targetCount: number) {
  const beds = await roomBedsForRoom(roomId);
  const current = sumBedCapacity(beds);

  if (current < targetCount) {
    const startSortOrder = await nextRoomBedSortOrder(roomId);
    const toAdd = targetCount - current;
    await db.insert(roomBeds).values(
      Array.from({ length: toAdd }, (_, index) => ({
        roomId,
        bedType: "single" as const,
        sortOrder: startSortOrder + index,
      }))
    );
  } else if (current > targetCount) {
    const highestFirst = [...beds].sort((a, b) => b.sortOrder - a.sortOrder || b.id - a.id);
    let toRemove = current - targetCount;
    for (const bed of highestFirst) {
      if (toRemove <= 0) break;
      await db.delete(roomBeds).where(eq(roomBeds.id, bed.id));
      toRemove -= bedCapacity(bed.bedType);
    }
  }

  await syncRoomBedCount(roomId);
}
