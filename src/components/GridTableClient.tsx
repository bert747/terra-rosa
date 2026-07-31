"use client";

import { useMemo, useState } from "react";
import { formatDateUk } from "@/lib/dates";
import { eventColourStyle, roomColourStyle } from "@/lib/room-colours";
import type { RoomGridRow, BedCell } from "@/lib/bed-grid";
import GuardianOccupancyPopup from "@/components/GuardianOccupancyPopup";

interface GridEvent {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
  notes: string | null;
}

interface EventBand {
  event: GridEvent;
  startIndex: number;
  span: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

type LaneCell = { kind: "band"; band: EventBand } | { kind: "gap"; span: number };

interface DragPayload {
  segmentId: number;
  bookingId: number;
  leadGuestName: string;
  fromRoomId: number;
  fromRoomName: string;
  fromBedNumber: number;
  sourceDate: string;
  startDate: string;
  endDate: string;
}

interface PendingMove {
  payload: DragPayload;
  toRoomId: number;
  toRoomName: string;
  toBedNumber: number;
  newStartDate: string;
  newEndDate: string;
}

// Custom MIME type so a bed-row drag never gets mistaken for a booking drag
// (bookings use the plain "application/json" type below).
const BED_DRAG_MIME = "application/x-terra-rosa-bed";

interface BedDragPayload {
  fromRoomId: number;
  fromRoomName: string;
  bedNumber: number;
}

interface PendingBedMove {
  fromRoomId: number;
  fromRoomName: string;
  bedNumber: number;
  toRoomId: number;
  toRoomName: string;
  startDate: string;
  endDate: string;
}

function laneCells(lane: EventBand[], dateCount: number): LaneCell[] {
  const cells: LaneCell[] = [];
  let cursor = 0;
  for (const band of lane) {
    if (band.startIndex > cursor) cells.push({ kind: "gap", span: band.startIndex - cursor });
    cells.push({ kind: "band", band });
    cursor = band.startIndex + band.span;
  }
  if (cursor < dateCount) cells.push({ kind: "gap", span: dateCount - cursor });
  return cells;
}

const WEEK_OPTIONS = [1, 2, 4] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

function bedLabel(cell: BedCell): string {
  const marker = cell.isArrival ? " <" : cell.isDeparture ? " /" : "";
  return `${cell.segment.leadGuestName}${marker}`;
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const targetMonthIndex = m - 1 + n;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);
  return new Date(Date.UTC(targetYear, targetMonth, day)).toISOString().slice(0, 10);
}

function spanDays(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.round((e - s) / dayMs));
}

export default function GridTableClient({
  start,
  today,
  weeks,
  dates,
  lastDate,
  grid,
  eventLanes,
  arrByDate,
  depByDate,
  overrideNotesByRoomDate,
  overrideSummaryByRoom,
  alerts,
}: {
  start: string;
  today: string;
  weeks: number;
  dates: string[];
  lastDate: string;
  grid: RoomGridRow[];
  eventLanes: EventBand[][];
  arrByDate: number[];
  depByDate: number[];
  overrideNotesByRoomDate: Record<string, Record<string, string>>;
  overrideSummaryByRoom: Record<string, string[]>;
  alerts: string[];
}) {
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [hoverCell, setHoverCell] = useState<{ roomId: number; bedNumber: number; dateIndex: number } | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [moving, setMoving] = useState(false);
  const [bedDragPayload, setBedDragPayload] = useState<BedDragPayload | null>(null);
  const [bedHoverRoomId, setBedHoverRoomId] = useState<number | null>(null);
  const [pendingBedMove, setPendingBedMove] = useState<PendingBedMove | null>(null);
  const [movingBed, setMovingBed] = useState(false);
  const [guardianPopup, setGuardianPopup] = useState<{
    bookingId: number;
    guardianName: string;
    date: string;
  } | null>(null);

  const dayColumnWidth = useMemo(() => {
    if (weeks === 1) return 120;
    if (weeks === 2) return 80;
    return 56;
  }, [weeks]);

  const dragSpan = dragPayload ? spanDays(dragPayload.startDate, dragPayload.endDate) : 0;
  const href = (newStart: string, newWeeks: number = weeks) => `/grid?start=${newStart}&weeks=${newWeeks}`;

  function isShadowCell(roomId: number, bedNumber: number, dateIndex: number): boolean {
    if (!dragPayload || !hoverCell) return false;
    if (hoverCell.roomId !== roomId || hoverCell.bedNumber !== bedNumber) return false;
    return dateIndex >= hoverCell.dateIndex && dateIndex < hoverCell.dateIndex + dragSpan;
  }

  async function confirmMove() {
    if (!pendingMove) return;
    setMoving(true);
    const res = await fetch(`/api/segments/${pendingMove.payload.segmentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: pendingMove.toRoomId,
        preferredBed: pendingMove.toBedNumber,
        startDate: pendingMove.newStartDate,
        endDate: pendingMove.newEndDate,
      }),
    });
    setMoving(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Could not move booking.");
      return;
    }

    setPendingMove(null);
    window.location.reload();
  }

  async function confirmBedMove() {
    if (!pendingBedMove) return;
    setMovingBed(true);
    const res = await fetch("/api/room-beds/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromRoomId: pendingBedMove.fromRoomId,
        toRoomId: pendingBedMove.toRoomId,
        count: 1,
        startDate: pendingBedMove.startDate,
        endDate: pendingBedMove.endDate || undefined,
        ongoing: !pendingBedMove.endDate,
      }),
    });
    setMovingBed(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Could not move that bed.");
      return;
    }

    setPendingBedMove(null);
    window.location.reload();
  }

  return (
    <>
      <a href="/dashboard">← Back to dashboard</a>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>
          Grid - {formatDateUk(start)} to {formatDateUk(lastDate)}
        </h1>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span className="tr-muted" style={{ fontSize: 12, marginRight: 2 }}>View</span>
          {WEEK_OPTIONS.map((w) => (
            <a key={w} href={href(start, w)}>
              <button className={w === weeks ? "primary" : undefined}>
                {w} {w === 1 ? "week" : "weeks"}
              </button>
            </a>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
        <a href={href(addMonths(start, -1))}><button>&laquo; Previous month</button></a>
        <a href={href(addDaysIso(start, -7))}><button>&lsaquo; Previous week</button></a>
        <a href={href(today)}><button>Today</button></a>
        <a href={href(addDaysIso(start, 7))}><button>Next week &rsaquo;</button></a>
        <a href={href(addMonths(start, 1))}><button>Next month &raquo;</button></a>
      </div>

      <div className="tr-card" style={{ overflowX: "auto", padding: 0 }}>
        <table className="tr-grid" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th className="tr-grid-room">Room</th>
              <th className="tr-grid-bed">Bed</th>
              {dates.map((d) => (
                <th
                  key={d}
                  className={isWeekend(d) ? "tr-grid-weekend" : undefined}
                  style={{ width: dayColumnWidth, minWidth: dayColumnWidth, maxWidth: dayColumnWidth }}
                >
                  <div>{weekday(d)}</div>
                  <div style={{ fontWeight: 400 }}>{formatDateUk(d).slice(0, 5)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eventLanes.map((lane, laneIndex) => (
              <tr key={`event-lane-${laneIndex}`} className="tr-grid-event-lane">
                <td className="tr-grid-room tr-grid-event-head" colSpan={2}>{laneIndex === 0 ? "Events" : ""}</td>
                {laneCells(lane, dates.length).map((cell, cellIndex) =>
                  cell.kind === "gap" ? (
                    <td key={`gap-${cellIndex}`} colSpan={cell.span} />
                  ) : (
                    <td
                      key={`band-${cell.band.event.id}`}
                      colSpan={cell.band.span}
                      className={[
                        "tr-grid-event",
                        cell.band.continuesBefore ? "tr-grid-event-open-start" : "",
                        cell.band.continuesAfter ? "tr-grid-event-open-end" : "",
                      ].filter(Boolean).join(" ")}
                      style={eventColourStyle(cell.band.event.id)}
                      title={`${cell.band.event.name} - ${formatDateUk(cell.band.event.startDate)} to ${formatDateUk(cell.band.event.endDate)}${cell.band.event.notes ? `\n${cell.band.event.notes}` : ""}`}
                    >
                      <a href="/events">
                        {cell.band.continuesBefore ? "< " : ""}
                        {cell.band.event.name}
                        {cell.band.continuesAfter ? " >" : ""}
                      </a>
                    </td>
                  )
                )}
              </tr>
            ))}

            {grid.map((room, roomIndex) =>
              room.beds.map((bed, bedRowIndex) => (
                <tr key={`${room.roomId}-${bed.bedNumber}`} className={bedRowIndex === 0 ? "tr-grid-room-start" : undefined} style={roomColourStyle(roomIndex)}>
                  {bedRowIndex === 0 && (
                    <td className="tr-grid-room" rowSpan={room.beds.length}>
                      <a href={`/rooms/${room.roomId}`} style={{ color: "inherit", textDecoration: "none", display: "block" }}>
                        <div style={{ fontWeight: 600 }}>{room.roomName}</div>
                      </a>
                      {room.locationOrType && <div className="tr-muted" style={{ fontSize: 11 }}>{room.locationOrType}</div>}
                      {!!overrideSummaryByRoom[String(room.roomId)]?.length && (
                        <div className="tr-muted" style={{ fontSize: 11, marginTop: 4 }} title={overrideSummaryByRoom[String(room.roomId)].join("\n")}>
                          Override note in this period
                        </div>
                      )}
                    </td>
                  )}

                  <td
                    className={`tr-grid-bed${bed.isOverflow ? " tr-grid-overflow" : ""}`}
                    draggable={!bed.isOverflow}
                    style={bed.isOverflow ? undefined : { cursor: "grab" }}
                    title={bed.isOverflow ? undefined : `Drag bed ${bed.bedNumber} to another room to move it`}
                    onDragStart={(e) => {
                      if (bed.isOverflow) return;
                      const payload: BedDragPayload = {
                        fromRoomId: room.roomId,
                        fromRoomName: room.roomName,
                        bedNumber: bed.bedNumber,
                      };
                      setBedDragPayload(payload);
                      e.dataTransfer.setData(BED_DRAG_MIME, JSON.stringify(payload));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setBedDragPayload(null);
                      setBedHoverRoomId(null);
                    }}
                  >
                    {bed.isOverflow ? "over" : bed.bedNumber}
                  </td>

                  {dates.map((d, i) => {
                    const cell = bed.cells[i];
                    const capacity = room.capacityByDate[i] ?? 0;
                    const unavailable = bed.bedNumber > capacity;
                    const overrideNote = overrideNotesByRoomDate[String(room.roomId)]?.[d];
                    const isMovedAway = unavailable && !!overrideNote && /lent to/i.test(overrideNote);

                    const classes = ["tr-grid-cell"];
                    if (isWeekend(d)) classes.push("tr-grid-weekend");
                    if (cell) {
                      classes.push("tr-grid-occupied");
                      if (cell.isArrival) classes.push("tr-grid-arrival");
                      if (cell.isDeparture) classes.push("tr-grid-departure");
                      if (!cell.segment.countsTowardCapacity) classes.push("tr-grid-noncounting");
                      if (unavailable) classes.push("tr-grid-conflict");
                    } else if (unavailable) {
                      classes.push("tr-grid-unavailable");
                      if (isMovedAway) classes.push("tr-grid-moved-away");
                    }
                    if (isShadowCell(room.roomId, bed.bedNumber, i)) classes.push("tr-grid-drop-shadow");
                    if (bedDragPayload && bedHoverRoomId === room.roomId && room.roomId !== bedDragPayload.fromRoomId) {
                      classes.push("tr-grid-drop-shadow");
                    }

                    return (
                      <td
                        key={`${room.roomId}-${bed.bedNumber}-${d}`}
                        className={classes.join(" ")}
                        style={{ width: dayColumnWidth, minWidth: dayColumnWidth, maxWidth: dayColumnWidth }}
                        onDragOver={(e) => {
                          if (bedDragPayload) {
                            if (room.roomId === bedDragPayload.fromRoomId) return;
                            e.preventDefault();
                            setBedHoverRoomId(room.roomId);
                            return;
                          }
                          if (unavailable || !dragPayload) return;
                          e.preventDefault();
                          setHoverCell({ roomId: room.roomId, bedNumber: bed.bedNumber, dateIndex: i });
                        }}
                        onDragEnter={() => {
                          if (bedDragPayload) {
                            if (room.roomId === bedDragPayload.fromRoomId) return;
                            setBedHoverRoomId(room.roomId);
                            return;
                          }
                          if (unavailable || !dragPayload) return;
                          setHoverCell({ roomId: room.roomId, bedNumber: bed.bedNumber, dateIndex: i });
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const bedRaw = e.dataTransfer.getData(BED_DRAG_MIME);
                          if (bedRaw) {
                            const bedPayload = JSON.parse(bedRaw) as BedDragPayload;
                            setBedDragPayload(null);
                            setBedHoverRoomId(null);
                            if (room.roomId === bedPayload.fromRoomId) return;
                            setPendingBedMove({
                              fromRoomId: bedPayload.fromRoomId,
                              fromRoomName: bedPayload.fromRoomName,
                              bedNumber: bedPayload.bedNumber,
                              toRoomId: room.roomId,
                              toRoomName: room.roomName,
                              startDate: d,
                              endDate: "",
                            });
                            return;
                          }
                          if (unavailable) return;
                          const raw = e.dataTransfer.getData("application/json");
                          if (!raw) return;
                          const payload = JSON.parse(raw) as DragPayload;
                          const duration = spanDays(payload.startDate, payload.endDate);
                          const movedRoomOrBed =
                            room.roomId !== payload.fromRoomId || bed.bedNumber !== payload.fromBedNumber;
                          // Default move semantics: when changing room/bed, keep
                          // the same date span. Shift dates only when dragged
                          // horizontally on the same bed.
                          const newStartDate = movedRoomOrBed ? payload.startDate : d;
                          const newEndDate = movedRoomOrBed ? payload.endDate : addDaysIso(newStartDate, duration);
                          setPendingMove({
                            payload,
                            toRoomId: room.roomId,
                            toRoomName: room.roomName,
                            toBedNumber: bed.bedNumber,
                            newStartDate,
                            newEndDate,
                          });
                          setDragPayload(null);
                          setHoverCell(null);
                        }}
                        onClick={() => {
                          if (!cell || cell.segment.bookingType !== "guardian") return;
                          setGuardianPopup({
                            bookingId: cell.segment.bookingId,
                            guardianName: cell.segment.leadGuestName,
                            date: d,
                          });
                        }}
                        title={
                          cell
                            ? `${cell.segment.leadGuestName} - ${cell.segment.bookingType}, ${formatDateUk(cell.segment.startDate)} to ${formatDateUk(cell.segment.endDate)}${cell.segment.notes ? `\n${cell.segment.notes}` : ""}`
                            : unavailable
                              ? `${room.roomName} has no bed ${bed.bedNumber} on ${formatDateUk(d)}${overrideNote ? `\nOverride note: ${overrideNote}` : ""}`
                              : `New booking - ${room.roomName}, night of ${formatDateUk(d)}${overrideNote ? `\nOverride note: ${overrideNote}` : ""}`
                        }
                      >
                        {cell ? (
                          <div className="tr-grid-occupied-wrap">
                            {cell.segment.bookingType === "guardian" ? (
                              <>
                                <span style={{ fontWeight: 600 }}>{bedLabel(cell)}</span>
                                <a
                                  href={`/bookings/${cell.segment.bookingId}`}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ marginLeft: 6, fontSize: 11 }}
                                >
                                  Open
                                </a>
                              </>
                            ) : (
                              <a
                                draggable
                                onDragStart={(e) => {
                                  const payload: DragPayload = {
                                    segmentId: cell.segment.id,
                                    bookingId: cell.segment.bookingId,
                                    leadGuestName: cell.segment.leadGuestName,
                                    fromRoomId: room.roomId,
                                    fromRoomName: room.roomName,
                                    fromBedNumber: bed.bedNumber,
                                    sourceDate: d,
                                    startDate: cell.segment.startDate,
                                    endDate: cell.segment.endDate,
                                  };
                                  setDragPayload(payload);
                                  e.dataTransfer.setData("application/json", JSON.stringify(payload));
                                }}
                                onDragEnd={() => {
                                  setDragPayload(null);
                                  setHoverCell(null);
                                }}
                                href={`/bookings/${cell.segment.bookingId}`}
                              >
                                {bedLabel(cell)}
                                {cell.segment.notes?.trim() ? (
                                  <span
                                    style={{
                                      marginLeft: 6,
                                      fontSize: 10,
                                      padding: "1px 4px",
                                      border: "1px solid currentColor",
                                      borderRadius: 3,
                                      opacity: 0.8,
                                    }}
                                  >
                                    Note
                                  </span>
                                ) : null}
                              </a>
                            )}
                          </div>
                        ) : unavailable ? (
                          ""
                        ) : (
                          <a className="tr-grid-new" href={`/bookings/new?roomId=${room.roomId}&checkIn=${d}&checkOut=${addDaysIso(d, 1)}`}>
                            +
                          </a>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}

            <tr className="tr-grid-summary">
              <td colSpan={2}>Occupied / beds</td>
              {dates.map((d, i) => {
                const occupied = grid.reduce((sum, room) => sum + room.occupancyByDate[i], 0);
                const beds = grid.reduce((sum, room) => sum + (room.capacityByDate[i] ?? 0), 0);
                return (
                  <td key={d} className={occupied > beds ? "tr-badge-warn" : undefined}>
                    {occupied}/{beds}
                  </td>
                );
              })}
            </tr>
            <tr className="tr-grid-summary">
              <td colSpan={2}>Arrivals</td>
              {dates.map((d, i) => <td key={d}>{arrByDate[i] || ""}</td>)}
            </tr>
            <tr className="tr-grid-summary">
              <td colSpan={2}>Departures</td>
              {dates.map((d, i) => <td key={d}>{depByDate[i] || ""}</td>)}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="tr-muted" style={{ fontSize: 12 }}>
        Drag an occupied booking to another bed/date cell. The highlighted shadow shows the full span before you drop.
        Drag a bed number in the "Bed" column to another room to move that physical bed — this is the only place bed
        moves happen now; the Rooms page is read-only for inventory.
      </p>

      {alerts.length > 0 && (
        <div className="tr-grid-alerts-corner">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Issues to fix ({alerts.length})</div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {alerts.slice(0, 12).map((a, i) => (
              <li key={`alert-${i}`} style={{ marginBottom: 4 }}>{a}</li>
            ))}
          </ul>
          {alerts.length > 12 && (
            <div className="tr-muted" style={{ marginTop: 6, fontSize: 12 }}>
              +{alerts.length - 12} more
            </div>
          )}
        </div>
      )}

      {pendingMove && (
        <div className="tr-move-modal-backdrop">
          <div className="tr-move-modal">
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>Confirm move</h3>
            <div className="tr-move-grid">
              <div>
                <div className="tr-muted" style={{ fontSize: 11 }}>From</div>
                <div><strong>{pendingMove.payload.leadGuestName}</strong></div>
                <div>{pendingMove.payload.fromRoomName} - Bed {pendingMove.payload.fromBedNumber}</div>
                <div>{formatDateUk(pendingMove.payload.startDate)} to {formatDateUk(pendingMove.payload.endDate)}</div>
              </div>
              <div className="tr-move-arrow">-&gt;</div>
              <div>
                <div className="tr-muted" style={{ fontSize: 11 }}>To</div>
                <div><strong>{pendingMove.payload.leadGuestName}</strong></div>
                <div>{pendingMove.toRoomName} - Bed {pendingMove.toBedNumber}</div>
                <div>{formatDateUk(pendingMove.newStartDate)} to {formatDateUk(pendingMove.newEndDate)}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button onClick={() => setPendingMove(null)} disabled={moving}>Cancel</button>
              <button className="primary" onClick={confirmMove} disabled={moving}>
                {moving ? "Moving..." : "Confirm move"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingBedMove && (
        <div className="tr-move-modal-backdrop">
          <div className="tr-move-modal" style={{ maxWidth: 480 }}>
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>Confirm bed move</h3>
            <p style={{ marginTop: 0 }}>
              Move 1 bed from <strong>{pendingBedMove.fromRoomName}</strong> to{" "}
              <strong>{pendingBedMove.toRoomName}</strong> starting {formatDateUk(pendingBedMove.startDate)}?
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginBottom: 10 }}>
              <div>
                <label style={{ display: "block", fontSize: 12 }}>Start date</label>
                <input
                  type="date"
                  required
                  value={pendingBedMove.startDate}
                  onChange={(e) => setPendingBedMove({ ...pendingBedMove, startDate: e.target.value })}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12 }}>End date (optional)</label>
                <input
                  type="date"
                  value={pendingBedMove.endDate}
                  onChange={(e) => setPendingBedMove({ ...pendingBedMove, endDate: e.target.value })}
                />
              </div>
            </div>
            <p className="tr-muted" style={{ marginTop: 0, fontSize: 12 }}>
              Leave end date blank to keep the move ongoing. Housekeeping will list this move on the start date, and
              the return move on the end date if you set one.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setPendingBedMove(null)} disabled={movingBed}>
                Cancel
              </button>
              <button className="primary" onClick={confirmBedMove} disabled={movingBed}>
                {movingBed ? "Moving..." : "Confirm move"}
              </button>
            </div>
          </div>
        </div>
      )}

      <GuardianOccupancyPopup
        open={guardianPopup !== null}
        bookingId={guardianPopup?.bookingId ?? null}
        guardianName={guardianPopup?.guardianName ?? ""}
        initialDate={guardianPopup?.date ?? today}
        onClose={() => setGuardianPopup(null)}
        onSaved={() => window.location.reload()}
      />
    </>
  );
}
