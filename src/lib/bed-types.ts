import { db } from "@/db";
import { bedTypes } from "@/db/schema";
import type { BedType } from "@/db/schema";

// Bed types are a user-managed catalogue (see /settings/layout and the
// bed_types table) rather than a hardcoded list — staff can add a new type
// (e.g. "Bunk") whenever they add that kind of bed to inventory. Every
// existing type still carries an explicit `capacity` (1 or 2 guests) set at
// creation time, so nothing downstream has to guess from the name.

/** The full bed-type catalogue, in creation order. */
export async function listBedTypes(): Promise<BedType[]> {
  return db.select().from(bedTypes).orderBy(bedTypes.id);
}

export async function isKnownBedType(type: string): Promise<boolean> {
  const rows = await listBedTypes();
  return rows.some((r) => r.name === type);
}

/**
 * type-name -> capacity, loaded once per request and threaded through the
 * hot per-bed capacity lookups in grid.ts / available-beds.ts /
 * booking-guard.ts instead of querying per bed.
 */
export async function loadBedCapacities(): Promise<Map<string, number>> {
  const rows = await listBedTypes();
  return new Map(rows.map((r) => [r.name, r.capacity]));
}

/** Capacity for one bed type, given a map from loadBedCapacities(). Falls
 *  back to 1 (a Single) for a type with no catalogue row — e.g. one whose
 *  bedTypes entry was since renamed/removed but existing beds still carry
 *  the old name (see the comment on beds.type in schema.ts). */
export function bedCapacity(capacities: Map<string, number>, type: string): number {
  return capacities.get(type) ?? 1;
}
