import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { roomBeds, rooms } from "@/db/schema";
import { requireEditor } from "@/lib/auth";
import { applyCapacityDelta } from "@/lib/capacity-overrides";
import { bedCapacity, ensureRoomBedsSeeded, sumBedCapacity, syncRoomBedCount } from "@/lib/room-beds";

export const dynamic = "force-dynamic";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Moving beds between rooms.
//
// The house has a fixed number of beds, so this is the only sanctioned way to
// change where they are: it always takes n beds off one room and puts the same
// n on another. Nothing here can create or destroy a bed — use
// /api/room-beds (POST/DELETE) for that, which is a separate, deliberate act.
//
// Two execution modes:
//
//   immediate move   starts today and has no end date. room_beds rows are
//                    reassigned and both rooms' default_bed_count is resynced.
//   scheduled move   any move with a future start date or an explicit end date.
//                    This is recorded as capacity overrides on both rooms.
//                    room_beds is untouched because the move is date-scoped.
//
// Caveat worth knowing: a permanent move changes default_bed_count, and an
// override covering a date beats the default on that date (see roomCapacity in
// src/lib/occupancy.ts). So if a room already has an override across some
// dates, a permanent move won't show up on those dates until the override
// lapses. That's the intended precedence, not a bug — the override is the more
// specific statement about that date.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    await requireEditor();
  } catch {
    return NextResponse.json({ error: "Editor role required" }, { status: 403 });
  }

  await ensureRoomBedsSeeded();

  const body = await req.json();
  const fromRoomId = Number(body.fromRoomId ?? 0);
  const toRoomId = Number(body.toRoomId ?? 0);
  const count = Number(body.count ?? 1);
  const rawStartDate = body.startDate ? String(body.startDate) : "";
  const rawEndDate = body.endDate ? String(body.endDate) : "";
  const ongoing = body.ongoing === undefined ? !rawEndDate : Boolean(body.ongoing);
  const startDate = rawStartDate || todayISO();
  const endDate = rawEndDate || (ongoing ? "9999-12-31" : "");
  const isImmediateMove = ongoing && !rawEndDate && startDate === todayISO();
  const requestedBedIds: number[] = Array.isArray(body.bedIds)
    ? body.bedIds.map((raw: unknown) => Number(raw)).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];

  if (!fromRoomId || !toRoomId) {
    return NextResponse.json({ error: "fromRoomId and toRoomId are required" }, { status: 400 });
  }
  if (fromRoomId === toRoomId) {
    return NextResponse.json({ error: "Pick a different room to move the bed to." }, { status: 400 });
  }
  if (!Number.isInteger(count) || count < 1) {
    return NextResponse.json({ error: "Number of beds to move must be at least 1." }, { status: 400 });
  }

  const [fromRoom] = await db.select().from(rooms).where(eq(rooms.id, fromRoomId)).limit(1);
  const [toRoom] = await db.select().from(rooms).where(eq(rooms.id, toRoomId)).limit(1);
  if (!fromRoom || !fromRoom.isActive) {
    return NextResponse.json({ error: "Room to move beds from was not found." }, { status: 404 });
  }
  if (!toRoom || !toRoom.isActive) {
    return NextResponse.json({ error: "Room to move beds to was not found." }, { status: 404 });
  }

  if (!ongoing && !rawEndDate) {
    return NextResponse.json(
      { error: "End date is required when the move is not ongoing." },
      { status: 400 }
    );
  }

  // --- Immediate ongoing move: reassign the actual room_beds rows ----------
  if (isImmediateMove) {
    const bedsInRoom = await db
      .select()
      .from(roomBeds)
      .where(eq(roomBeds.roomId, fromRoomId))
      .orderBy(asc(roomBeds.sortOrder), asc(roomBeds.id));

    const available = sumBedCapacity(bedsInRoom);
    if (available < count) {
      return NextResponse.json(
        {
          error: `${fromRoom.name} has ${available} bed(s) — cannot move ${count}.`,
        },
        { status: 409 }
      );
    }

    // Honour the beds the caller dragged, then top up from the end of the room
    // (highest sort order first) so bed 1 keeps its number where possible.
    // A joined pair is one row worth two beds, so this counts capacity, not rows.
    const moving = bedsInRoom.filter((bed) => requestedBedIds.includes(bed.id));
    let moved = sumBedCapacity(moving);
    for (const bed of [...bedsInRoom].reverse()) {
      if (moved >= count) break;
      if (moving.some((entry) => entry.id === bed.id)) continue;
      moving.push(bed);
      moved += bedCapacity(bed.bedType);
    }

    // Only a joined pair can overshoot. Splitting one up as a side effect of a
    // move would be a surprise, so say so and let them choose.
    if (moved !== count) {
      return NextResponse.json(
        {
          error:
            `That would move ${moved} bed(s), not ${count} — one of them is two singles joined together. ` +
            `Move ${moved} beds instead, or unjoin the pair first in Bed inventory.`,
        },
        { status: 409 }
      );
    }

    await db.transaction(async (tx) => {
      const bedsInTarget = await tx.select().from(roomBeds).where(eq(roomBeds.roomId, toRoomId));
      let nextSortOrder =
        bedsInTarget.reduce((acc, bed) => Math.max(acc, bed.sortOrder), 0) + 1;

      for (const bed of moving) {
        await tx
          .update(roomBeds)
          .set({ roomId: toRoomId, sortOrder: nextSortOrder })
          .where(eq(roomBeds.id, bed.id));
        nextSortOrder += 1;
      }
    });

    // Renumber the source room so its remaining beds stay 1..n.
    const remaining = await db
      .select()
      .from(roomBeds)
      .where(eq(roomBeds.roomId, fromRoomId))
      .orderBy(asc(roomBeds.sortOrder), asc(roomBeds.id));
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].sortOrder !== i + 1) {
        await db.update(roomBeds).set({ sortOrder: i + 1 }).where(eq(roomBeds.id, remaining[i].id));
      }
    }

    await syncRoomBedCount(fromRoomId);
    await syncRoomBedCount(toRoomId);

    return NextResponse.json({
      ok: true,
      mode: "permanent",
      movedBedIds: moving.map((bed) => bed.id),
      message: `Moved ${count} bed(s) from ${fromRoom.name} to ${toRoom.name} from now on.`,
    });
  }

  // --- Scheduled move: capacity overrides on both rooms ---------------------
  if (startDate >= endDate) {
    return NextResponse.json({ error: "End date must be after the start date." }, { status: 400 });
  }

  const note = String(body.note ?? "").trim();
  const fromNote = note || `${count} bed(s) lent to ${toRoom.name}`;
  const toNote = note || `${count} bed(s) borrowed from ${fromRoom.name}`;

  let failure: string | null = null;
  await db.transaction(async (tx) => {
    const out = await applyCapacityDelta(tx, {
      roomId: fromRoomId,
      startDate,
      endDate,
      delta: -count,
      defaultBedCount: fromRoom.defaultBedCount,
      note: fromNote,
    });
    if (!out.ok) {
      failure = out.error ?? "Could not take the beds out of that room.";
      throw new Error(failure);
    }

    const back = await applyCapacityDelta(tx, {
      roomId: toRoomId,
      startDate,
      endDate,
      delta: count,
      defaultBedCount: toRoom.defaultBedCount,
      note: toNote,
    });
    if (!back.ok) {
      failure = back.error ?? "Could not add the beds to that room.";
      throw new Error(failure);
    }
  }).catch((err) => {
    if (!failure) failure = err instanceof Error ? err.message : "Could not move the beds.";
  });

  if (failure) return NextResponse.json({ error: failure }, { status: 409 });

  return NextResponse.json({
    ok: true,
    mode: endDate === "9999-12-31" ? "ongoing" : "dated",
    message:
      endDate === "9999-12-31"
        ? `Moved ${count} bed(s) from ${fromRoom.name} to ${toRoom.name} from ${startDate} onward.`
        : `Moved ${count} bed(s) from ${fromRoom.name} to ${toRoom.name} for ${startDate} to ${endDate}.`,
  });
}
