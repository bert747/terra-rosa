import { db } from "@/db";
import { beds, bedLocations, bookings, joinedBeds, rooms } from "@/db/schema";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { ISODate } from "@/lib/occupancy";

/**
 * One user-facing "Planned Changes" line — either a bed physically moving
 * room ("move"), or a bed-type configuration change: singles pairing up
 * into a Double ("join-start") or a Double due to split back apart
 * ("join-end"). Same panel, same cancel/undo treatment, because from a
 * planning point of view they're the same kind of thing: something on the
 * books that hasn't happened yet.
 */
export interface PlannedChangeLine {
  id: string;
  kind: "move" | "join-start" | "join-end";
  bedType: string;
  /** Set for "move" only. */
  fromRoomName?: string;
  /** Set for "move" (destination) and "join-start"/"join-end" (the room the join is in). */
  toRoomName: string;
  startDate: ISODate;
  /** null = permanent — nothing else is scheduled to change this again. */
  endDate: ISODate | null;
  count: number;
  /** "move" lines: the bed_locations row ids — pass to cancelPlannedMoves. */
  bedLocationIds: number[];
  /** "join-start"/"join-end" lines: the joined_beds row ids — pass to cancelPlannedJoinChange. */
  joinedBedIds: number[];
}

function todayISO(): ISODate {
  return new Date().toISOString().slice(0, 10);
}

interface RawMove {
  bedType: string;
  fromRoomId: number;
  toRoomId: number;
  startDate: ISODate;
  endDate: ISODate | null;
  locationId: number;
}

/**
 * Every future bed relocation already on the books, netted per (bed type,
 * start date, end date) so an intermediate room a bed only passes through
 * for bookkeeping reasons never shows up as its own line — only where beds
 * actually end up, and when.
 */
async function findPlannedMoveLines(): Promise<PlannedChangeLine[]> {
  const today = todayISO();

  const [allLocations, bedRows, roomRows] = await Promise.all([
    db.select().from(bedLocations),
    db.select().from(beds),
    db.select().from(rooms),
  ]);

  const bedTypeById = new Map(bedRows.map((b) => [b.id, b.type]));
  const roomNameById = new Map(roomRows.map((r) => [r.id, r.name]));

  const byBed = new Map<number, typeof allLocations>();
  for (const seg of allLocations) {
    const list = byBed.get(seg.bedId);
    if (list) list.push(seg);
    else byBed.set(seg.bedId, [seg]);
  }

  // A "move" is a segment starting strictly after today whose immediately
  // preceding segment (contiguous — no gap) was in a DIFFERENT room. A
  // segment starting after a gap (the bed was unplaced in between) isn't a
  // move so much as a fresh placement with no "from" to describe.
  const rawMoves: RawMove[] = [];
  for (const [bedId, segs] of byBed) {
    const sorted = [...segs].sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const seg = sorted[i];
      if (seg.startDate <= today) continue;
      if (prev.endDate !== seg.startDate) continue;
      if (prev.roomId === seg.roomId) continue;
      rawMoves.push({
        bedType: bedTypeById.get(bedId) ?? "bed",
        fromRoomId: prev.roomId,
        toRoomId: seg.roomId,
        startDate: seg.startDate,
        endDate: seg.endDate,
        locationId: seg.id,
      });
    }
  }

  const groups = new Map<string, RawMove[]>();
  for (const m of rawMoves) {
    const key = `${m.bedType}|${m.startDate}|${m.endDate ?? ""}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }

  const lines: PlannedChangeLine[] = [];
  for (const moves of groups.values()) {
    const { bedType, startDate, endDate } = moves[0];

    // Edge contraction: a room with as many arrivals as departures within
    // this group (net zero) is a pure pass-through — Infirmary in "Ensuite
    // → Infirmary → Ashrami" — so splice its one-in/one-out pair into a
    // single Ensuite → Ashrami edge, carrying BOTH rows' ids forward. Repeat
    // until every remaining room is a genuine source or sink. This is what
    // the old version got wrong: it derived the same net LABEL via delta
    // matching, but never actually unioned the pass-through room's own row
    // into the result, so cancelling a line (or "delete all") silently
    // missed it — the bed advancing single-handedly stayed on the books.
    let edges: { from: number; to: number; ids: number[] }[] = moves.map((m) => ({
      from: m.fromRoomId,
      to: m.toRoomId,
      ids: [m.locationId],
    }));

    let contracted = true;
    while (contracted) {
      contracted = false;
      const netByRoom = new Map<number, number>();
      for (const e of edges) {
        netByRoom.set(e.from, (netByRoom.get(e.from) ?? 0) - 1);
        netByRoom.set(e.to, (netByRoom.get(e.to) ?? 0) + 1);
      }
      for (const [roomId, net] of netByRoom) {
        if (net !== 0) continue;
        const inIndex = edges.findIndex((e) => e.to === roomId);
        const outIndex = edges.findIndex((e) => e.from === roomId);
        if (inIndex === -1 || outIndex === -1 || inIndex === outIndex) continue;
        const incoming = edges[inIndex];
        const outgoing = edges[outIndex];
        const merged = { from: incoming.from, to: outgoing.to, ids: [...incoming.ids, ...outgoing.ids] };
        edges = edges.filter((_, i) => i !== inIndex && i !== outIndex);
        edges.push(merged);
        contracted = true;
        break;
      }
    }

    // A fully round-tripped batch (A → B and B → A cancelling exactly) can
    // contract down to a from===to edge — genuinely zero net effect, so
    // nothing to report. (Those rows are pointless but harmless; "delete
    // all" is scoped to what's actually displayed, same as any single line.)
    const byPair = new Map<string, typeof edges>();
    for (const e of edges) {
      if (e.from === e.to) continue;
      const key = `${e.from}|${e.to}`;
      const list = byPair.get(key);
      if (list) list.push(e);
      else byPair.set(key, [e]);
    }

    for (const [key, pairEdges] of byPair) {
      const [fromStr, toStr] = key.split("|");
      lines.push({
        id: `move|${bedType}|${fromStr}|${toStr}|${startDate}|${endDate ?? ""}`,
        kind: "move",
        bedType,
        fromRoomName: roomNameById.get(Number(fromStr)) ?? "unknown room",
        toRoomName: roomNameById.get(Number(toStr)) ?? "unknown room",
        startDate,
        endDate,
        count: pairEdges.length,
        bedLocationIds: pairEdges.flatMap((e) => e.ids),
        joinedBedIds: [],
      });
    }
  }

  return lines;
}

/**
 * Every future bed-CONFIGURATION change already on the books — singles due
 * to pair up into a Double ("join-start"), or an already-active Double due
 * to split back apart ("join-end"). Same "planned, hasn't happened yet"
 * category as a physical move, so it belongs in the same panel — this is
 * exactly the Dorm 2 case that used to be invisible: a bed-type change with
 * no room change at all previously triggered nothing here.
 */
async function findPlannedJoinChangeLines(): Promise<PlannedChangeLine[]> {
  const today = todayISO();

  const [startingJoinsRaw, endingJoinsRaw, bedRows, locationRows, roomRows] = await Promise.all([
    db.select().from(joinedBeds).where(and(eq(joinedBeds.mode, "double"), gt(joinedBeds.startDate, today))),
    db
      .select()
      .from(joinedBeds)
      .where(and(eq(joinedBeds.mode, "double"), lte(joinedBeds.startDate, today), or(isNull(joinedBeds.endDate), gt(joinedBeds.endDate, today)))),
    db.select().from(beds),
    db.select().from(bedLocations),
    db.select().from(rooms),
  ]);
  const bedTypeById = new Map(bedRows.map((b) => [b.id, b.type]));
  const roomNameById = new Map(roomRows.map((r) => [r.id, r.name]));

  // A row whose endDate isn't strictly after its startDate is degenerate —
  // never actually active for any date — same defensive filter as
  // buildHousekeepingSheet's joinsStartingTodayValid, for the same reason:
  // a stale row like that would otherwise surface as a nonsense line here.
  const startingJoins = startingJoinsRaw.filter((j) => j.endDate == null || j.endDate > j.startDate);
  const endingJoins = endingJoinsRaw.filter((j) => j.endDate == null || j.endDate > j.startDate);

  /** Whatever room bed1Id is in as of `date` — both halves of a join are always co-located, so bed1 alone is enough. */
  function roomIdAt(bedId: number, date: ISODate): number | null {
    const active = locationRows.find((l) => l.bedId === bedId && l.startDate <= date && (l.endDate == null || l.endDate > date));
    return active?.roomId ?? null;
  }

  const lines: PlannedChangeLine[] = [];

  // join-start: only real if BOTH halves are still plain Singles today —
  // if either is already part of a DIFFERENT active join, this scheduled
  // one can't actually take effect as planned (a conflict the join UI
  // itself would reject at the time), so it's not worth surfacing as a
  // clean upcoming change.
  const startGroups = new Map<string, typeof startingJoins>();
  for (const j of startingJoins) {
    const roomId = roomIdAt(j.bed1Id, j.startDate);
    if (roomId == null) continue;
    const key = `${roomId}|${j.startDate}|${j.endDate ?? ""}`;
    const list = startGroups.get(key);
    if (list) list.push(j);
    else startGroups.set(key, [j]);
  }
  for (const [key, joins] of startGroups) {
    const [roomIdStr, startDate, endDateStr] = key.split("|");
    lines.push({
      id: `join-start|${key}`,
      kind: "join-start",
      bedType: bedTypeById.get(joins[0].bed1Id) ?? "Single",
      toRoomName: roomNameById.get(Number(roomIdStr)) ?? "unknown room",
      startDate,
      endDate: endDateStr || null,
      count: joins.length,
      bedLocationIds: [],
      joinedBedIds: joins.map((j) => j.id),
    });
  }

  const endGroups = new Map<string, typeof endingJoins>();
  for (const j of endingJoins) {
    if (j.endDate == null) continue; // no scheduled end — nothing "planned" to report
    const roomId = roomIdAt(j.bed1Id, j.endDate);
    if (roomId == null) continue;
    const key = `${roomId}|${j.endDate}`;
    const list = endGroups.get(key);
    if (list) list.push(j);
    else endGroups.set(key, [j]);
  }
  for (const [key, joins] of endGroups) {
    const [roomIdStr, endDate] = key.split("|");
    lines.push({
      id: `join-end|${key}`,
      kind: "join-end",
      bedType: bedTypeById.get(joins[0].bed1Id) ?? "Single",
      toRoomName: roomNameById.get(Number(roomIdStr)) ?? "unknown room",
      startDate: endDate, // the line reads "from {endDate}" either way — see the frontend template
      endDate: null,
      count: joins.length,
      bedLocationIds: [],
      joinedBedIds: joins.map((j) => j.id),
    });
  }

  return lines;
}

export async function findPlannedChanges(): Promise<PlannedChangeLine[]> {
  const [moveLines, joinLines] = await Promise.all([findPlannedMoveLines(), findPlannedJoinChangeLines()]);
  return [...moveLines, ...joinLines].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.toRoomName.localeCompare(b.toRoomName));
}

export interface AffectedBooking {
  bookingId: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}

/**
 * Bookings that would be silently left assuming a room/bed-type layout that
 * never actually happens if these planned changes were cancelled instead of
 * left to take effect — e.g. a guest booked expecting a Double that's only
 * scheduled to actually FORM on some future date; cancelling that join
 * before it happens leaves them booked into a configuration nobody set up.
 * The threshold date per bed comes straight off the underlying row rather
 * than needing the caller to resend it: a "move"'s own bed_locations.
 * startDate IS the date it was going to take effect; a join-start's own
 * startDate likewise; a join-end's own endDate (not startDate — the join
 * is already active) is when it was going to stop applying. A booking on
 * that bed departing after that date is relying on this change happening.
 */
export async function findBookingsAffectedByCancel(
  bedLocationIds: number[],
  joinCancellations: { id: number; kind: "start" | "end" }[]
): Promise<AffectedBooking[]> {
  const checks: { bedId: number; thresholdDate: ISODate }[] = [];

  if (bedLocationIds.length > 0) {
    const locs = await db.select().from(bedLocations).where(inArray(bedLocations.id, bedLocationIds));
    for (const loc of locs) checks.push({ bedId: loc.bedId, thresholdDate: loc.startDate });
  }
  if (joinCancellations.length > 0) {
    const joins = await db.select().from(joinedBeds).where(inArray(joinedBeds.id, joinCancellations.map((c) => c.id)));
    for (const j of joins) {
      const c = joinCancellations.find((x) => x.id === j.id);
      if (!c) continue;
      const thresholdDate = c.kind === "start" ? j.startDate : j.endDate;
      if (thresholdDate == null) continue; // "end" with no scheduled end — nothing to check
      checks.push({ bedId: j.bed1Id, thresholdDate });
      checks.push({ bedId: j.bed2Id, thresholdDate });
    }
  }
  if (checks.length === 0) return [];

  const bedIds = [...new Set(checks.map((c) => c.bedId))];
  const rows = await db.select().from(bookings).where(inArray(bookings.bedId, bedIds));

  const seen = new Set<number>();
  const affected: AffectedBooking[] = [];
  for (const b of rows) {
    if (b.bedId == null) continue;
    if (!seen.has(b.id) && checks.some((c) => c.bedId === b.bedId && b.departureDate > c.thresholdDate)) {
      seen.add(b.id);
      affected.push({ bookingId: b.id, guestName: b.guestName, arrivalDate: b.arrivalDate, departureDate: b.departureDate });
    }
  }
  return affected.sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
}

/**
 * Cancels specific planned moves — splices each given bed_locations row back
 * out and re-extends its immediate predecessor to cover the time it used to,
 * so the bed reads as never having left. Independent per row, so this
 * correctly handles both a single planned move and one link in a longer
 * chain (an unrelated later move for the same bed, if any, is untouched).
 *
 * Returns enough per-bed info for the caller to make this undoable WITHOUT
 * tracking row ids across the round-trip (ids change once anything is
 * recreated) — exactly the same shape as moveBed's own undo/redo: "undo"
 * is just POSTing the bed back to (toRoomId, startDate, endDate) to restore
 * the plan, "redo" is POSTing it to (fromRoomId, startDate) to cancel it
 * again — both plain bed_locations moves, not id-dependent.
 */
export interface CancelledMoveInfo {
  bedId: number;
  fromRoomId: number;
  toRoomId: number;
  startDate: ISODate;
  endDate: ISODate | null;
}

export async function cancelPlannedMoves(bedLocationIds: number[]): Promise<CancelledMoveInfo[]> {
  const cancelled: CancelledMoveInfo[] = [];
  await db.transaction(async (tx) => {
    for (const id of bedLocationIds) {
      const [seg] = await tx.select().from(bedLocations).where(eq(bedLocations.id, id));
      if (!seg) continue;
      const bedRows = await tx.select().from(bedLocations).where(eq(bedLocations.bedId, seg.bedId));
      const predecessor = bedRows.find((row) => row.id !== seg.id && row.endDate === seg.startDate);
      await tx.delete(bedLocations).where(eq(bedLocations.id, id));
      if (predecessor) {
        await tx.update(bedLocations).set({ endDate: seg.endDate }).where(eq(bedLocations.id, predecessor.id));
        cancelled.push({ bedId: seg.bedId, fromRoomId: predecessor.roomId, toRoomId: seg.roomId, startDate: seg.startDate, endDate: seg.endDate });
      }
    }
  });
  return cancelled;
}

/**
 * Cancels one planned join-configuration change. "start" (a scheduled
 * pairing that hasn't happened yet) deletes the row outright — it never
 * existed. "end" (an active double scheduled to split back apart) just
 * clears the row's own endDate, making it open-ended/permanent again — the
 * row itself, and its id, are untouched. Returns the row's state from
 * BEFORE the change, which is enough to undo either case: recreate the
 * exact row (POST /api/joined-beds) for "start", or PATCH the endDate back
 * for "end" — see cancelPlannedMoveLines in GridCanvas.tsx for the mirror
 * pattern this follows.
 */
export interface CancelledJoinChangeInfo {
  id: number;
  kind: "start" | "end";
  bed1Id: number;
  bed2Id: number;
  mode: "double" | "solo";
  startDate: ISODate;
  endDate: ISODate | null;
}

export async function cancelPlannedJoinChange(id: number, kind: "start" | "end"): Promise<CancelledJoinChangeInfo | null> {
  const [join] = await db.select().from(joinedBeds).where(eq(joinedBeds.id, id));
  if (!join) return null;

  if (kind === "start") {
    await db.delete(joinedBeds).where(eq(joinedBeds.id, id));
  } else {
    await db.update(joinedBeds).set({ endDate: null }).where(eq(joinedBeds.id, id));
  }

  return { id: join.id, kind, bed1Id: join.bed1Id, bed2Id: join.bed2Id, mode: join.mode, startDate: join.startDate, endDate: join.endDate };
}

/**
 * The alternative to cancelling outright when a booking is already relying
 * on the CURRENT setup for longer than the planned change accounted for
 * (see findBookingsAffectedByCancel): push the change's own effective date
 * later instead of abandoning it — same change, just once those bookings
 * are actually out of the way. Re-scheduling a bed's move to its already-
 * intended room is nothing more than moving it there again at a later
 * date, so this reuses the exact same splice-then-insert POST
 * /api/bed-locations itself does (any existing segment overlapping the new
 * date gets truncated or deleted, same as a normal move) rather than a
 * separate update path — one fewer thing that could drift out of sync with
 * how a move is applied everywhere else. Returns the ORIGINAL (startDate,
 * endDate, room) per bed, which is enough for the caller's undo/redo to
 * just replay this same operation at either date via that same endpoint —
 * consistent with cancelPlannedMoves' own undo/redo below.
 */
export interface DelayedMoveInfo {
  bedId: number;
  toRoomId: number;
  originalStartDate: ISODate;
  originalEndDate: ISODate | null;
  pushedDate: ISODate;
}

export async function delayPlannedMoves(bedLocationIds: number[], pushedDate: ISODate): Promise<DelayedMoveInfo[]> {
  const delayed: DelayedMoveInfo[] = [];
  await db.transaction(async (tx) => {
    for (const id of bedLocationIds) {
      const [seg] = await tx.select().from(bedLocations).where(eq(bedLocations.id, id));
      if (!seg) continue;
      const conflicting = await tx
        .select()
        .from(bedLocations)
        .where(and(eq(bedLocations.bedId, seg.bedId), or(isNull(bedLocations.endDate), gt(bedLocations.endDate, pushedDate))));
      for (const row of conflicting) {
        if (row.startDate >= pushedDate) await tx.delete(bedLocations).where(eq(bedLocations.id, row.id));
        else await tx.update(bedLocations).set({ endDate: pushedDate }).where(eq(bedLocations.id, row.id));
      }
      await tx.insert(bedLocations).values({ bedId: seg.bedId, roomId: seg.roomId, startDate: pushedDate, endDate: seg.endDate });
      delayed.push({ bedId: seg.bedId, toRoomId: seg.roomId, originalStartDate: seg.startDate, originalEndDate: seg.endDate, pushedDate });
    }
  });
  return delayed;
}

export interface DelayedJoinChangeInfo {
  id: number;
  kind: "start" | "end";
  /** The field actually being pushed: startDate for "start", endDate for "end". */
  originalDate: ISODate | null;
  pushedDate: ISODate;
}

export async function delayPlannedJoinChange(id: number, kind: "start" | "end", pushedDate: ISODate): Promise<DelayedJoinChangeInfo | null> {
  const [join] = await db.select().from(joinedBeds).where(eq(joinedBeds.id, id));
  if (!join) return null;
  const originalDate = kind === "start" ? join.startDate : join.endDate;
  if (kind === "start") {
    await db.update(joinedBeds).set({ startDate: pushedDate }).where(eq(joinedBeds.id, id));
  } else {
    await db.update(joinedBeds).set({ endDate: pushedDate }).where(eq(joinedBeds.id, id));
  }
  return { id, kind, originalDate, pushedDate };
}
