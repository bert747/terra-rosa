import { db } from "@/db";
import { beds, bookings } from "@/db/schema";
import { and, eq, gt, lt, notInArray } from "drizzle-orm";
import { loadBedCapacities } from "@/lib/bed-types";
import type { ISODate } from "@/lib/occupancy";

function todayISO(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

type BookingRow = typeof bookings.$inferSelect;

/** A booking blocking a merge segment. */
export interface SplitMergeConflict {
  bookingId: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}

export interface SplitMergePreview {
  ok: true;
  /** Nothing to do — every future night is already on the target bed. */
  alreadyMerged: boolean;
  targetBedId: number;
  /** Every future conflict, across every segment that would need to move. */
  conflicts: SplitMergeConflict[];
  /** True only when there's exactly one conflicting booking, and its WHOLE date range could cleanly swap into the bed being vacated — the common, unambiguous case. */
  canSwap: boolean;
}

export type SplitMergeResult = { ok: true; resultBookingId: number } | { ok: false; error: string };

async function bedCapacity(bedId: number): Promise<number> {
  const [bed] = await db.select().from(beds).where(eq(beds.id, bedId));
  if (!bed) return 1;
  const capacities = await loadBedCapacities();
  return capacities.get(bed.type) ?? 1;
}

/**
 * Who's on `bedId` during [arrivalDate, departureDate) that would actually
 * BLOCK one more occupant landing there — a plain Single (capacity 1)
 * blocks on any overlap at all, but a native two-person bed (capacity 2)
 * has room for one more even with someone already in it, same rule
 * checkBedCapacity (booking-guard.ts) enforces on every other write.
 */
async function findBlockingConflicts(bedId: number, arrivalDate: ISODate, departureDate: ISODate, excludeIds: number[]): Promise<BookingRow[]> {
  const capacity = await bedCapacity(bedId);
  const conditions = [eq(bookings.bedId, bedId), lt(bookings.arrivalDate, departureDate), gt(bookings.departureDate, arrivalDate)];
  if (excludeIds.length > 0) conditions.push(notInArray(bookings.id, excludeIds));
  const overlapping = await db.select().from(bookings).where(and(...conditions));
  if (overlapping.length + 1 <= capacity) return []; // still room for the merged segment too
  return overlapping;
}

/**
 * Every OTHER piece of `booking`'s split lineage, restated as the segment
 * that would need to land on `booking`'s own bed to merge — clipped to
 * "today onward" (the past never moves; see the module-level rule this
 * whole feature follows). A sibling whose stay straddles today gets
 * reported as starting today, not its own original arrival — the caller
 * splits it there before actually moving anything.
 */
function futureSegments(booking: BookingRow, siblings: BookingRow[], today: ISODate): { source: BookingRow; arrivalDate: ISODate; departureDate: ISODate }[] {
  const segments: { source: BookingRow; arrivalDate: ISODate; departureDate: ISODate }[] = [];
  for (const s of siblings) {
    if (s.id === booking.id) continue;
    if (s.bedId === booking.bedId) continue; // already on the target bed — nothing to move
    if (s.departureDate <= today) continue; // entirely past — untouched
    const arrivalDate = s.arrivalDate < today ? today : s.arrivalDate;
    segments.push({ source: s, arrivalDate, departureDate: s.departureDate });
  }
  return segments;
}

export async function previewSplitMerge(bookingId: number): Promise<SplitMergePreview | { ok: false; error: string }> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) return { ok: false, error: "Booking not found." };
  if (!booking.splitGroupId || booking.bedId == null) return { ok: false, error: "This booking isn't part of a split." };

  const siblings = await db.select().from(bookings).where(eq(bookings.splitGroupId, booking.splitGroupId));
  const today = todayISO();
  const segments = futureSegments(booking, siblings, today);

  if (segments.length === 0) {
    return { ok: true, alreadyMerged: true, targetBedId: booking.bedId, conflicts: [], canSwap: false };
  }

  const conflicts: SplitMergeConflict[] = [];
  const excludeIds = siblings.map((s) => s.id);
  for (const seg of segments) {
    const overlapping = await findBlockingConflicts(booking.bedId, seg.arrivalDate, seg.departureDate, excludeIds);
    for (const o of overlapping) {
      if (!conflicts.some((c) => c.bookingId === o.id)) {
        conflicts.push({ bookingId: o.id, guestName: o.guestName, arrivalDate: o.arrivalDate, departureDate: o.departureDate });
      }
    }
  }

  // A clean swap only makes sense when there's exactly one thing in the
  // way, and its WHOLE stay (not just the overlapping nights) can move
  // into the bed being vacated without conflicting there either — the same
  // "reciprocal fit" the grid's own drag-to-swap already requires. Anything
  // messier (multiple conflicts, or a conflict that only partially
  // overlaps and needs splitting) isn't a "swap" so much as its own
  // separate manual move — offering it here would silently do more than
  // the guest holding it. Only "unallocate the conflicting nights" is
  // offered instead.
  let canSwap = false;
  if (conflicts.length === 1) {
    const blocker = conflicts[0];
    const segmentContainingBlocker = segments.find(
      (seg) => blocker.arrivalDate < seg.departureDate && seg.arrivalDate < blocker.departureDate
    );
    if (segmentContainingBlocker) {
      const vacatedBedId = segmentContainingBlocker.source.bedId!;
      const reciprocal = await findBlockingConflicts(vacatedBedId, blocker.arrivalDate, blocker.departureDate, excludeIds.concat(blocker.bookingId));
      canSwap = reciprocal.length === 0;
    }
  }

  return { ok: true, alreadyMerged: false, targetBedId: booking.bedId, conflicts, canSwap };
}

/**
 * Applies the merge: moves every future segment onto the target bed
 * (splitting a sibling at today first if its stay straddles it), then
 * chains the standard adjacent-booking merge (same mechanism a same-day
 * checkout/check-in merge already uses) across everything now sitting
 * contiguously on that one bed, so the result reads as ONE booking, not
 * several coincidentally-adjacent ones. `resolution` only matters when
 * previewSplitMerge reported conflicts: "swap" trades the one blocking
 * booking into the vacated bed; "unallocate" clears bedId on just the
 * conflicting segment(s) instead of moving them.
 */
export async function applySplitMerge(bookingId: number, resolution?: "swap" | "unallocate"): Promise<SplitMergeResult> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!booking) return { ok: false, error: "Booking not found." };
  if (!booking.splitGroupId || booking.bedId == null) return { ok: false, error: "This booking isn't part of a split." };
  const targetBedId = booking.bedId;
  const today = todayISO();

  const siblings = await db.select().from(bookings).where(eq(bookings.splitGroupId, booking.splitGroupId));
  const segments = futureSegments(booking, siblings, today);
  if (segments.length === 0) return { ok: true, resultBookingId: bookingId };

  const excludeIds = siblings.map((s) => s.id);

  // First pass: split off exactly the future portion of every segment that
  // straddles today (mirrors POST /api/bookings/[id]/split), so every
  // segment maps to one concrete row holding ONLY its future nights before
  // anything below ever touches a bedId. Resolving conflicts against the
  // pre-split sibling row instead (its bedId still covers the past nights
  // too, since the split hadn't happened yet) would drag those past nights
  // onto the target bed as a side effect of the very next pass.
  const segmentRowIds = new Map<number, number>(); // segments index -> concrete row id
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.arrivalDate === seg.source.arrivalDate) {
      segmentRowIds.set(i, seg.source.id);
    } else {
      await db.update(bookings).set({ departureDate: seg.arrivalDate }).where(eq(bookings.id, seg.source.id));
      const [created] = await db
        .insert(bookings)
        .values({
          guestName: seg.source.guestName,
          firstName: seg.source.firstName,
          lastName: seg.source.lastName,
          preferredName: seg.source.preferredName,
          notes: seg.source.notes,
          arrivalDate: seg.arrivalDate,
          departureDate: seg.departureDate,
          linkedBookingId: seg.source.linkedBookingId,
          bedId: seg.source.bedId,
          dietariesTags: seg.source.dietariesTags,
          splitGroupId: seg.source.splitGroupId ?? seg.source.id,
        })
        .returning();
      segmentRowIds.set(i, created.id);
      // A newly-created split-off row isn't one of the original siblings,
      // so without this it isn't in `excludeIds` either — the very next
      // pass's own "is anything blocking the target bed" check would then
      // treat the segment's own row (once moved onto the target bed) as a
      // conflicting THIRD-PARTY booking and immediately unallocate it again.
      excludeIds.push(created.id);
    }
  }

  // Second pass: resolve conflicts (or bail if none was given and one
  // exists — same 409-then-resubmit shape as the join-conflict flow).
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const rowId = segmentRowIds.get(i)!;
    const overlapping = await findBlockingConflicts(targetBedId, seg.arrivalDate, seg.departureDate, excludeIds);
    if (overlapping.length === 0) continue;
    if (!resolution) {
      return { ok: false, error: `${overlapping[0].guestName} is in this bed on those nights — resolve the conflict first.` };
    }
    if (resolution === "swap" && overlapping.length === 1) {
      const blocker = overlapping[0];
      await db.transaction(async (tx) => {
        await tx.update(bookings).set({ bedId: targetBedId }).where(eq(bookings.id, rowId));
        await tx.update(bookings).set({ bedId: seg.source.bedId }).where(eq(bookings.id, blocker.id));
      });
    }
    // resolution === "unallocate" (or a swap that wasn't 1:1 clean): leave
    // as blocked here — the third pass below unallocates it instead of
    // moving it.
  }

  // Third pass: move whatever isn't already on the target bed (or
  // unallocate it, if it's still blocked after the swap above).
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const rowId = segmentRowIds.get(i)!;
    const stillBlocking = await findBlockingConflicts(targetBedId, seg.arrivalDate, seg.departureDate, excludeIds);
    const newBedId = stillBlocking.length === 0 ? targetBedId : null;
    await db.update(bookings).set({ bedId: newBedId }).where(eq(bookings.id, rowId));
  }

  // Fourth pass: chain-merge everything that ended up contiguous on the
  // target bed back into one booking, same as any ordinary same-day
  // checkout/check-in merge — repeat until nothing more coalesces. Filtered
  // by splitGroupId (not the `siblings` array fetched above) since the
  // first pass above can itself insert a brand-new row (the future half of
  // a sibling split at today) that `siblings` — a pre-mutation snapshot —
  // never knew about; splitGroupId is propagated onto that new row too,
  // so it's the one membership check that stays correct after the mutation.
  let merged = true;
  let onTarget: BookingRow[] = [];
  while (merged) {
    merged = false;
    onTarget = await db.select().from(bookings).where(eq(bookings.bedId, targetBedId));
    const relevant = onTarget
      .filter((b) => b.splitGroupId === booking.splitGroupId)
      .sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
    for (let i = 0; i < relevant.length - 1; i++) {
      if (relevant[i].departureDate === relevant[i + 1].arrivalDate && relevant[i].guestName === relevant[i + 1].guestName) {
        await db.update(bookings).set({ departureDate: relevant[i + 1].departureDate }).where(eq(bookings.id, relevant[i].id));
        await db.delete(bookings).where(eq(bookings.id, relevant[i + 1].id));
        merged = true;
        break;
      }
    }
  }

  // The clicked booking's own row can end up deleted by the coalescing pass
  // above (it becomes the LATER half of a contiguous pair, whose id is
  // always the one dropped — see that pass) — callers (the booking edit
  // page in particular) need to know which id now actually represents it,
  // so they can navigate there instead of reloading a row that's gone.
  const resultBooking = onTarget.find(
    (b) => b.splitGroupId === booking.splitGroupId && b.arrivalDate <= booking.arrivalDate && booking.arrivalDate < b.departureDate
  );

  return { ok: true, resultBookingId: resultBooking?.id ?? bookingId };
}
