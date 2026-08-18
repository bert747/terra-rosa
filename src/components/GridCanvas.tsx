"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { formatDateUk, isIsoDate, nightsBetween } from "@/lib/dates";
import { eventColourStyle, roomColourStyle } from "@/lib/room-colours";
import type { GridData } from "@/lib/grid-data";
import type { PlannedChangeLine } from "@/lib/bed-moves";
import type { SplitSiblingBooking } from "@/lib/split-siblings";
import { addDays, type ISODate } from "@/lib/occupancy";
import { pillColourVars } from "@/lib/pill-colour";
import ToastStack, { type ToastMessage } from "@/components/ToastStack";
import ContextMenu, { type ContextMenuItem, type ContextMenuState } from "@/components/ContextMenu";
import BedActionModal, { type BedActionModalState } from "@/components/BedActionModal";
import JoinActionModal, { type JoinActionModalState } from "@/components/JoinActionModal";
import JoinConflictModal, { type JoinConflictModalState } from "@/components/JoinConflictModal";
import SplitMergeConflictModal, { type SplitMergeConflictModalState } from "@/components/SplitMergeConflictModal";
import PlannedChangeConflictModal, { type PlannedChangeConflictModalState } from "@/components/PlannedChangeConflictModal";
import ConfirmModal, { type ConfirmModalState } from "@/components/ConfirmModal";
import { CalendarIcon, CalendarPopover } from "@/components/DateField";
import { useGuestCategories } from "@/lib/use-guest-categories";
import HelpButton from "@/components/HelpButton";
import type { GroupMoveProposal } from "@/lib/group-move";
import type { RoomFixOption } from "@/lib/allocation-fixes";

const COLUMN_WIDTH = 64;
const ROOM_COL_WIDTH = 140;
const BED_COL_WIDTH = 110;
// Sticky-positioning math for the frozen Events row(s) — see the
// tr-grid-event-lane rows below. Matches the header row's own `height: 32px`
// (see .tr-grid th, .tr-grid td) plus its 1px bottom border, and each event
// lane's own shorter `height: 26px` (see .tr-grid-event-lane > td).
const HEADER_ROW_HEIGHT = 33;
const GRID_ROW_HEIGHT = 26;
const YEARS_BACK = 2;
const YEARS_FORWARD = 2;
// The loaded window stays a fixed ~60 days wide the whole time — as the
// visible range nears an edge, the window SHIFTS (fetches the next stretch,
// drops the far side) rather than growing, so the DOM/data payload never
// balloons no matter how far someone scrolls in one session.
const ROLLING_WINDOW_DAYS = 60;
const EDGE_BUFFER_DAYS = 20;
// Dampens native mouse-wheel/trackpad scroll speed over the grid viewport —
// see the wheel listener near flushPanScroll for why. 1 = native (unchanged)
// speed; smaller is slower.
const WHEEL_SCROLL_FACTOR = 0.45;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Plain line-art icon in currentColor, matching CalendarIcon's own style
// (see DateField.tsx) — the ⚙ glyph it replaces rendered as a thin, tiny
// character at normal button font sizes with no clean way to make it read
// as a deliberate icon rather than stray punctuation.
function GearIcon({ size = 16 }: { size?: number }) {
  // A real gear silhouette (rounded teeth around a ring, hollow centre) —
  // the previous hand-rolled version (a small circle with thin radiating
  // lines) read as a brightness/sun icon instead of a settings cog.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82A1.65 1.65 0 0 0 3 14H2.91A2 2 0 0 1 1 12a2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function dayOfWeek(date: ISODate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function weekday(date: ISODate): string {
  return WEEKDAYS[dayOfWeek(date)];
}

function isWeekend(date: ISODate): boolean {
  const day = dayOfWeek(date);
  return day === 0 || day === 6;
}

function isPastDay(date: ISODate, today: ISODate): boolean {
  return date < today;
}

// Remembers roughly where staff last left the grid (which date was leftmost
// on screen, how far scrolled down) so navigating away — into a booking,
// to another page's nav tab, whatever — and back doesn't dump them back at
// "today" every time. sessionStorage (not localStorage): scoped to this
// browser tab's lifetime, which matches "where I left the grid" better than
// a value that'd otherwise persist forever across unrelated sessions/days.
const GRID_VIEW_STATE_KEY = "tr-grid-view-state";

interface GridViewState {
  date: ISODate;
  scrollTop: number;
}

function readSavedGridViewState(): GridViewState | null {
  try {
    const raw = sessionStorage.getItem(GRID_VIEW_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !isIsoDate(parsed.date) || typeof parsed.scrollTop !== "number") return null;
    return { date: parsed.date, scrollTop: parsed.scrollTop };
  } catch {
    return null;
  }
}

function saveGridViewState(state: GridViewState) {
  try {
    sessionStorage.setItem(GRID_VIEW_STATE_KEY, JSON.stringify(state));
  } catch {
    // Private browsing / storage full / whatever — losing the remembered
    // position isn't worth surfacing an error over.
  }
}

/**
 * Inline style overriding a booking pill's colour to its guest category's
 * own colour. Sets --tr-booking-color, --tr-booking-fill, --tr-booking-
 * border AND --tr-booking-border-width rather than just the first — the
 * other three are each declared once, in globals.css, as a color-mix()/
 * fixed value nested off --tr-booking-color; browsers resolve a nested
 * var() against whatever --tr-booking-color was AT THE POINT the outer
 * property's OWN inherited value was last computed, not against a closer
 * override on the same element — so overriding only the color left the
 * others silently stuck on the default. See pillColourVars (src/lib/pill-
 * colour.ts, shared with the Layout settings page) for what actually
 * computes them.
 */
function bookingColourVars(colour: string | null | undefined): React.CSSProperties {
  if (!colour) return {};
  return pillColourVars(colour) as React.CSSProperties;
}

/**
 * "Join **2 single beds** as a **couple double** in **Sea 1**" / "from
 * **05/08/2026**" — see the Planned Changes panel. Active voice throughout
 * (an instruction the panel is about to carry out, not a passive
 * description of something happening on its own) so it reads as what the
 * button DOES, with the key nouns bolded so the sentence scans instead of
 * reading as one flat run of text. Deliberately rendered as two explicit
 * lines — the WHAT, then the WHEN — rather than left to wrap organically:
 * a plain single-line string wraps wherever the panel's fixed width
 * happens to force a break, which is rarely a sensible spot once room/
 * guest names vary in length; splitting right here guarantees the break
 * always lands after the change itself, never mid-phrase.
 */
function plannedChangeLineText(m: PlannedChangeLine): React.ReactNode {
  // A join always involves exactly 2 physical beds per formation — m.count
  // counts separate simultaneous formations, not beds, so the bed count
  // shown here is always double it.
  const bedCount = m.kind === "move" ? m.count : m.count * 2;
  const label = bedCount === 1 ? m.bedType : `${m.bedType}s`;
  const couple = m.count === 1 ? "Couple Double" : `${m.count} Couple Doubles`;
  const when = (
    <>
      from <strong>{formatDateUk(m.startDate)}</strong>
      {m.endDate && (
        <>
          {" "}
          until <strong>{formatDateUk(m.endDate)}</strong>
        </>
      )}
    </>
  );

  let what: React.ReactNode;
  if (m.kind === "move") {
    what = (
      <>
        Move <strong>{bedCount} {label}</strong> from <strong>{m.fromRoomName}</strong> to <strong>{m.toRoomName}</strong>
      </>
    );
  } else if (m.kind === "join-start") {
    what = (
      <>
        Join <strong>{bedCount} {label}</strong> as a <strong>{couple}</strong> in <strong>{m.toRoomName}</strong>
      </>
    );
  } else {
    what = (
      <>
        Split the <strong>{couple}</strong> in <strong>{m.toRoomName}</strong> back into <strong>{bedCount} {label}</strong>
      </>
    );
  }

  return (
    <>
      <div>{what}</div>
      <div className="tr-muted" style={{ fontSize: 12 }}>{when}</div>
    </>
  );
}

/**
 * What an affected booking is CURRENTLY sitting in, for
 * PlannedChangeConflictModal's wording — the setup "Cancel" would leave
 * them in, as opposed to whatever the (blocked) change was about to make
 * it. Only meaningful for a single line at a time (the common case — one
 * "Delete" click); a batch "Delete all" spanning several different lines
 * falls back to a plain, still-accurate description rather than guessing
 * at a single bed type that wouldn't apply to all of them.
 */
function plannedChangeConfigDescription(lines: PlannedChangeLine[]): string {
  if (lines.length !== 1) return "their current beds";
  const l = lines[0];
  if (l.kind === "move") return `the ${l.bedType}`;
  if (l.kind === "join-start") return `${l.bedType} beds`;
  return "the Couple Double";
}

/** Per-browser display preference (gear icon menu) — how much of a booking's name its pill shows. */
type PillNameMode = "first" | "firstInitial" | "firstLast";

/**
 * What a booking's pill actually shows: its own preferredName if staff set
 * one (a short/preferred form — see the schema column's own doc comment),
 * else its firstName — that's the whole of the "First name" mode. The other
 * two modes append the last name's initial or the whole last name onto
 * that same base, e.g. "Luca" / "Luca I" / "Luca Ilari". guestName itself
 * is untouched everywhere else (bookings list, exports, the daily sheet,
 * the title tooltip on this very pill) — this is purely about fitting a
 * name into a pill that's often narrower than someone's full name.
 */
function pillDisplayName(booking: GridBooking, mode: PillNameMode): string {
  const base = booking.preferredName || booking.firstName;
  const lastName = booking.lastName?.trim();
  if (!lastName) return base;
  if (mode === "firstInitial") return `${base} ${lastName[0]}`;
  if (mode === "firstLast") return `${base} ${lastName}`;
  return base;
}

/**
 * A long-stay pill's name (see .tr-grid-pill-name) sits at the LEFT edge of
 * its <a> — normal for a stay of a few days, since arrival and the name are
 * both on screen together. But the pill's own <td> spans its full run of
 * nights regardless of how much of that is currently scrolled into view: for
 * a months-long booking, scrolling into the middle of the stay leaves the
 * coloured pill filling the screen with its name scrolled off past the
 * frozen Room/Bed columns, unreadable with nothing on screen saying whose
 * booking it is. Rather than always showing a name tooltip (most bookings
 * are short enough that the name's already sitting right there — repeating
 * it in a tooltip on every hover would just be noise), this only returns a
 * value when the name span's own on-screen box doesn't actually overlap the
 * visible part of the viewport (right of the frozen columns, within the
 * viewport's own bounds) — i.e. exactly the case where the name truly isn't
 * visible right now.
 */
function pillNameIfHidden(pillEl: HTMLElement, actions: GridActions, name: string): string | undefined {
  const vp = actions.viewportRef.current;
  const nameSpan = pillEl.querySelector<HTMLElement>(".tr-grid-pill-name");
  if (!vp || !nameSpan) return undefined;
  const nameRect = nameSpan.getBoundingClientRect();
  const vpRect = vp.getBoundingClientRect();
  const visibleLeft = vpRect.left + actions.stickyLabelWidth;
  const hidden = nameRect.right <= visibleLeft || nameRect.left >= vpRect.right;
  return hidden ? name : undefined;
}

// Bed-type names (e.g. the stored "1.5-bed") get Title Cased with dashes
// turned into spaces when used inside a composite mode label like "Switch to
// Couple 1.5 Bed" — plain bed-type references elsewhere stay exactly as
// configured (e.g. "Single"), this is only for the compound names.
function formatBedTypeLabel(type: string): string {
  return type
    .split("-")
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

// Weekend shading renders as one continuous "wallpaper" tiled across the
// real calendar (7-day repeating gradient, Sun/Sat bands tinted) rather than
// a per-cell class toggle. A booking pill spans one <td> via colSpan across
// however many dates it covers — if that run happened to include a weekend
// boundary, a per-cell class would either force the pill to break there
// (splitting/repeating the guest name) or paint the wrong dates. Anchoring
// this gradient to each cell's own first date and letting CSS tile it means
// the right days land shaded inside a pill of any width, with no run-breaking
// needed. See .tr-grid-cell / .tr-grid-inactive in globals.css, which must
// keep WEEK_CYCLE_WIDTH (448px = COLUMN_WIDTH * 7) in sync with this file.
const WEEK_CYCLE_WIDTH = COLUMN_WIDTH * 7;
const WEEKEND_TINT = "rgba(0, 0, 0, 0.055)";
const WEEKEND_GRADIENT = `repeating-linear-gradient(to right, ${WEEKEND_TINT} 0, ${WEEKEND_TINT} ${COLUMN_WIDTH}px, transparent ${COLUMN_WIDTH}px, transparent ${COLUMN_WIDTH * 6}px, ${WEEKEND_TINT} ${COLUMN_WIDTH * 6}px, ${WEEKEND_TINT} ${WEEK_CYCLE_WIDTH}px)`;

function weekendOverlayVars(date: ISODate): React.CSSProperties {
  const offset = dayOfWeek(date) * COLUMN_WIDTH;
  return {
    ["--tr-weekend-image" as string]: WEEKEND_GRADIENT,
    ["--tr-weekend-pos" as string]: `${-offset}px 0`,
  } as React.CSSProperties;
}

function addDaysIso(date: ISODate, days: number): ISODate {
  return addDays(date, days);
}

interface UnassignedBooking {
  guestName: string;
  arrivalDate: string;
  departureDate: string;
}

// --- Occupancy index: which booking(s) sit on a given bed on a given date -
//
// The drag's collision check needs to answer "is this target bed free for
// the dragged booking's date range?" — and, for the swap-reciprocity check,
// "would moving booking X's OWN unchanged dates into bed Y collide with
// anything else there?" — without re-deriving any of it from the DOM.
// Module-level (like pillDragState below) and rebuilt via a useEffect
// whenever `data` changes, keyed "bedId:date" -> bookings present that
// night. A plain array (not a Set) per key because a capacity-2 native bed
// (Queen/1.5/Double) can have two different bookings — one per slot — on
// the same date.
interface OccupancyEntry {
  id: number;
  guestName: string;
  arrivalDate: ISODate;
  departureDate: ISODate;
}
type OccupancyIndex = Map<string, OccupancyEntry[]>;
let occupancyIndex: OccupancyIndex = new Map();

// bedId -> how many bookings that bed can hold at once (unit.slots.length is
// already exactly this — 2 for a native Queen/1.5/Double, 1 for everything
// else, including each half of a joined pair, which are separate bedIds
// each with their own capacity 1). Rebuilt alongside occupancyIndex — see
// onPillPointerMove's move branch, which needs this to tell "the target bed
// has room for one more" (a plain valid drop) apart from "the target bed is
// genuinely full" (a swap candidate, or invalid) — the old capacity-blind
// check treated ANY existing occupant as blocking, so dropping a second
// guest onto an otherwise-empty second slot of a capacity-2 bed was
// misread as needing to evict whoever was already there.
let bedCapacityIndex: Map<number, number> = new Map();

function occupancyKey(bedId: number, date: ISODate): string {
  return `${bedId}:${date}`;
}

function buildBedCapacityIndex(grid: RoomGridRow[]): Map<number, number> {
  const index = new Map<number, number>();
  for (const room of grid) {
    for (const unit of room.units) {
      index.set(unit.bedId, unit.slots.length);
    }
  }
  return index;
}

function buildOccupancyIndex(grid: RoomGridRow[], dates: ISODate[]): OccupancyIndex {
  const index: OccupancyIndex = new Map();
  for (const room of grid) {
    for (const unit of room.units) {
      for (const slot of unit.slots) {
        slot.cells.forEach((cell, i) => {
          if (cell.state !== "booked" || !cell.booking || !dates[i]) return;
          const key = occupancyKey(unit.bedId, dates[i]);
          const existing = index.get(key);
          const entry: OccupancyEntry = {
            id: cell.booking.id,
            guestName: cell.booking.guestName,
            arrivalDate: cell.booking.arrivalDate,
            departureDate: cell.booking.departureDate,
          };
          if (existing) existing.push(entry);
          else index.set(key, [entry]);
        });
      }
    }
  }
  return index;
}

/** Every OTHER booking occupying `bedId` on any night in [arrivalDate, departureDate). */
function conflictingBookings(
  bedId: number,
  arrivalDate: ISODate,
  departureDate: ISODate,
  excludeBookingId: number
): OccupancyEntry[] {
  const conflicts = new Map<number, OccupancyEntry>();
  for (let d = arrivalDate; d < departureDate; d = addDaysIso(d, 1)) {
    for (const entry of occupancyIndex.get(occupancyKey(bedId, d)) ?? []) {
      if (entry.id !== excludeBookingId) conflicts.set(entry.id, entry);
    }
  }
  return [...conflicts.values()];
}

/**
 * Every OTHER Single, not-already-joined bed in `room`, for a "Join as
 * Couple/Solo Double" partner picker — never assume the array-adjacent bed
 * is the one staff actually meant (see JoinActionModal's own doc comment):
 * a room with a pre-existing occupied Single and two newly moved-in free
 * ones sorts by bedId, not by which pair makes sense, so the default offered
 * partner can easily be the occupied one. Labelled with each bed's own
 * occupancy on `dataIndex` so the picker itself makes the difference obvious
 * without staff needing to know bed ids.
 */
function singleUnitPartnerOptions(room: RoomGridRow, excludeBedId: number, dataIndex: number | null): { bedId: number; label: string; occupied: boolean }[] {
  return room.units
    .filter((u) => u.bedId !== excludeBedId && u.slots.length === 1 && u.partnerUnitKey == null && u.label.toLowerCase() === "single")
    .map((u) => {
      const cell = dataIndex != null ? u.slots[0].cells[dataIndex] : null;
      const occupant = cell?.state === "booked" ? cell.booking?.guestName : null;
      return { bedId: u.bedId, label: occupant ? `Single — occupied by ${occupant}` : "Single — free", occupied: occupant != null };
    });
}

/**
 * The grid's "Display settings" gear button + dropdown. Split out of
 * GridCanvas itself so its own hover/open state doesn't live on that
 * component — GridCanvas renders every room row without memoization (only
 * columns are virtualized), so any state change there reconciles the whole
 * grid. This menu's own local state (open/closed, which row is hovered for
 * its live preview, the measured preview-name width) previously lived on
 * GridCanvas and made the preview feel slow to open/hover on any property
 * with a lot of rows, even though the preview itself is two static mock
 * pills — nothing about it actually needs the real grid data.
 */
function GridSettingsMenu({
  showSharesWithText,
  onShowSharesWithTextChange,
  showHoverDetails,
  onShowHoverDetailsChange,
  pillNameMode,
  onPillNameModeChange,
}: {
  showSharesWithText: boolean;
  onShowSharesWithTextChange: (value: boolean) => void;
  showHoverDetails: boolean;
  onShowHoverDetailsChange: (value: boolean) => void;
  pillNameMode: PillNameMode;
  onPillNameModeChange: (value: PillNameMode) => void;
}) {
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  // Measured so the "booking details when hovering" preview's mock tooltip
  // can start a few px past the actual rendered end of the preview name —
  // a hardcoded percentage would drift out of sync the moment the name
  // (or the font) changed.
  const [previewNameWidth, setPreviewNameWidth] = useState(0);
  // Which Display settings row (if either) the pointer is currently over —
  // while hovering, that row's own preview shows what you'd GET by
  // clicking (the opposite of the current setting), not the current
  // setting itself. That's the whole point of hovering it: an instant
  // "here's what turning this on/off looks like" even when nothing in the
  // grid right now happens to demonstrate it (e.g. no booking currently in
  // view has a Sleeps-near/Shares-bed pairing to look at).
  const [hoveredPreviewToggle, setHoveredPreviewToggle] = useState<"sharesWith" | "hoverDetails" | null>(null);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Grid display settings"
        data-tooltip="Grid display settings"
        onClick={() => setSettingsMenuOpen((v) => !v)}
        // height matches every other toolbar button's own real rendered
        // height (40px, from the default button padding — see
        // globals.css) rather than shrinking to the icon's own smaller
        // natural size; padding trimmed down from the default 14px
        // sides (sized for text) since a single icon doesn't need that
        // much horizontal breathing room — it was rendering noticeably
        // WIDER than tall, an odd shape next to square-ish icon
        // buttons elsewhere.
        style={{ height: 40, padding: "0 11px", display: "inline-flex", alignItems: "center" }}
      >
        <GearIcon size={18} />
      </button>
      {settingsMenuOpen && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setSettingsMenuOpen(false)} />
          <div className="tr-actions-menu tr-settings-menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40 }}>
            <div className="tr-actions-menu-title">Display settings</div>
            <label
              className="tr-settings-toggle-row"
              onMouseEnter={() => setHoveredPreviewToggle("sharesWith")}
              onMouseLeave={() => setHoveredPreviewToggle((v) => (v === "sharesWith" ? null : v))}
            >
              <input
                type="checkbox"
                checked={showSharesWithText}
                onChange={(e) => onShowSharesWithTextChange(e.target.checked)}
                className="tr-settings-checkbox"
              />
              <span className="tr-settings-toggle-label">
                <div style={{ fontWeight: 600 }}>&quot;Shares with&quot; info in grid</div>
                <div className="tr-muted" style={{ fontSize: 11, marginTop: 2 }}>
                  Spells out &quot;(same bed as X)&quot; or &quot;(same room as X)&quot; on every pill with a Sleeps-near/Shares-bed pairing. Turn off to keep just the small icon.
                </div>
              </span>
              {/* Live preview, not a static screenshot — always matches what the toggle actually does, in both themes.
                  "Luca" and "Rob" — sample names for this preview only, not real guest names anywhere else in
                  the app. minWidth is sized for the LONGER (toggle-on) state specifically so the pill doesn't
                  visibly resize when the "(same bed as X)" text appears/disappears — it should always look this
                  wide. While the row is hovered, this shows what CLICKING would produce (the opposite of the
                  current setting), not the current setting itself — an instant preview of the effect even when
                  nothing in the real grid right now happens to demonstrate it. */}
              <div className="tr-settings-preview">
                <span className="tr-grid-booking-pill" style={{ position: "static", minWidth: 220 }}>
                  <span className="tr-grid-pill-satisfied" aria-hidden="true">👥</span>
                  <span className="tr-grid-pill-name">Luca</span>
                  {(hoveredPreviewToggle === "sharesWith" ? !showSharesWithText : showSharesWithText) && (
                    <span className="tr-grid-pill-relation">
                      (same bed as <strong>Rob</strong>)
                    </span>
                  )}
                </span>
              </div>
            </label>
            <label
              className="tr-settings-toggle-row"
              onMouseEnter={() => setHoveredPreviewToggle("hoverDetails")}
              onMouseLeave={() => setHoveredPreviewToggle((v) => (v === "hoverDetails" ? null : v))}
            >
              <input
                type="checkbox"
                checked={showHoverDetails}
                onChange={(e) => onShowHoverDetailsChange(e.target.checked)}
                className="tr-settings-checkbox"
              />
              <span className="tr-settings-toggle-label">
                <div style={{ fontWeight: 600 }}>Booking details when hovering</div>
                <div className="tr-muted" style={{ fontSize: 11, marginTop: 2 }}>
                  Shows the stay dates in a tooltip near the cursor when you hover a pill. The name&apos;s already on the pill, so it isn&apos;t repeated. Alerts keep their own hover text either way.
                </div>
              </span>
              {/* Same live-preview idea as the row above, but for the
                  tooltip itself — reuses the real tooltip bubble class
                  (see TooltipHost.tsx / globals.css) as a static mock.
                  Deliberately a plain pill with no shares-with icon/text
                  of its own — this toggle applies to every pill, shared
                  or not, so the preview shouldn't imply it's specific to
                  that case. Positioned a few px past the name's own
                  measured width, vertically centered on the pill —
                  roughly where a real cursor sits once you've actually
                  read the name before pausing to hover. Shows the
                  click-would-produce state while the row itself is
                  hovered, same as the row above. */}
              <div className="tr-settings-preview">
                <span className="tr-grid-booking-pill" style={{ position: "relative", minWidth: 170 }}>
                  <span
                    className="tr-grid-pill-name"
                    ref={(el) => {
                      if (!el) return;
                      const pillEl = el.closest<HTMLElement>(".tr-grid-booking-pill");
                      if (!pillEl) return;
                      setPreviewNameWidth(el.getBoundingClientRect().right - pillEl.getBoundingClientRect().left);
                    }}
                  >
                    Luca
                  </span>
                  {(hoveredPreviewToggle === "hoverDetails" ? !showHoverDetails : showHoverDetails) && (
                    <div
                      className="tr-tooltip-bubble"
                      style={{
                        position: "absolute",
                        top: "50%",
                        left: previewNameWidth + 8,
                        transform: "translateY(-100%)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      06/08/2026 to 10/08/2026
                    </div>
                  )}
                </span>
              </div>
            </label>
            <div className="tr-settings-toggle-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              <span className="tr-settings-toggle-label" style={{ display: "block" }}>
                <div style={{ fontWeight: 600 }}>Guest name shown on pill</div>
                <div className="tr-muted" style={{ fontSize: 11, marginTop: 2 }}>
                  How much of the name fits before it gets crowded — most stays are only a few days, so First name alone is usually enough room.
                </div>
              </span>
              {(
                [
                  { value: "first", label: "First name", example: "Luca" },
                  { value: "firstInitial", label: "First name + initial", example: "Luca I" },
                  { value: "firstLast", label: "First name + full surname", example: "Luca Ilari" },
                ] as const
              ).map((opt) => (
                <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="pillNameMode"
                    className="tr-settings-checkbox"
                    checked={pillNameMode === opt.value}
                    onChange={() => onPillNameModeChange(opt.value)}
                  />
                  {opt.label}
                  <span className="tr-muted" style={{ fontSize: 11 }}>({opt.example})</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function GridCanvas({ initialData, today }: { initialData: GridData; today: ISODate }) {
  const router = useRouter();
  const epochStart = useMemo(() => addDays(today, -365 * YEARS_BACK), [today]);
  const totalColumns = 365 * (YEARS_BACK + YEARS_FORWARD);

  const [data, setData] = useState<GridData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jumpValue, setJumpValue] = useState(today);
  const [jumpPickerOpen, setJumpPickerOpen] = useState(false);
  const fetchTokenRef = useRef(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Legend below the grid — active categories only (a deactivated one might
  // still colour an old booking's pill, but isn't worth explaining in a
  // legend of what you can currently pick).
  const guestCategoriesForLegend = useGuestCategories().filter((c) => c.active);

  // Room/Bed sticky label columns auto-narrow to fit whatever's actually on
  // screen, rather than a fixed width that either wastes space or clips a
  // long room name. Measured off the DATA (via an offscreen canvas, not the
  // DOM) so it's correct on the very first paint — a rendered cell's own
  // width can't be used to measure its "natural" content width since the
  // table is `table-layout: fixed`, which clips/stretches cells to whatever
  // width the column is already given, the exact circularity this avoids.
  const [labelColWidths, setLabelColWidths] = useState({ room: ROOM_COL_WIDTH, bed: BED_COL_WIDTH });

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const roomNameEl = vp.querySelector<HTMLElement>(".tr-grid-room-name");
    const roomMetaEl = vp.querySelector<HTMLElement>(".tr-grid-room-meta");
    const bedEl = vp.querySelector<HTMLElement>(".tr-grid-bed");
    if (!roomNameEl || !bedEl) return;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nameFont = getComputedStyle(roomNameEl).font;
    const metaFont = roomMetaEl ? getComputedStyle(roomMetaEl).font : nameFont;
    const bedFont = getComputedStyle(bedEl).font;

    let maxRoom = 0;
    for (const room of data.grid) {
      ctx.font = nameFont;
      maxRoom = Math.max(maxRoom, ctx.measureText(room.roomName).width);
      ctx.font = metaFont;
      maxRoom = Math.max(maxRoom, ctx.measureText(room.floorName).width);
    }
    let maxBed = 0;
    for (const room of data.grid) {
      for (const unit of room.units) {
        ctx.font = bedFont;
        maxBed = Math.max(maxBed, ctx.measureText(unit.label).width);
      }
    }

    // Padding pads out to roughly match each cell's own CSS padding/inset —
    // approximate is fine, a couple of spare pixels beats clipping.
    setLabelColWidths({
      room: Math.ceil(Math.max(90, maxRoom + 28)),
      bed: Math.ceil(Math.max(40, maxBed + 20)),
    });
  }, [data.grid]);

  const roomCellStyle = useMemo<React.CSSProperties>(
    () => ({ left: 0, width: labelColWidths.room, minWidth: labelColWidths.room, maxWidth: labelColWidths.room }),
    [labelColWidths.room]
  );
  const bedCellStyle = useMemo<React.CSSProperties>(
    () => ({ left: labelColWidths.room, width: labelColWidths.bed, minWidth: labelColWidths.bed, maxWidth: labelColWidths.bed }),
    [labelColWidths.room, labelColWidths.bed]
  );

  // bedId -> its current room/type label — used only for the split-sibling
  // nav chevrons' hover preview ("Single in Sea 1"), which needs to describe
  // where the OTHER part of the split currently lives without staff having
  // to scroll there first to find out.
  const bedInfoById = useMemo(() => {
    const map = new Map<number, { bedLabel: string; roomName: string }>();
    for (const room of data.grid) {
      for (const unit of room.units) {
        map.set(unit.bedId, { bedLabel: unit.label, roomName: room.roomName });
      }
    }
    return map;
  }, [data.grid]);

  const dataStartIndex = useMemo(() => nightsBetween(epochStart, data.start), [epochStart, data.start]);

  const virtualizer = useVirtualizer({
    count: totalColumns,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => COLUMN_WIDTH,
    horizontal: true,
    overscan: 6,
  });

  // `virtualizer.scrollToIndex` writes scrollLeft imperatively; the
  // virtualizer doesn't recompute `getVirtualItems()` for that until the
  // NEXT render. Any effect that reads virtualColumns right after a scroll
  // (e.g. the "grow loaded window" effect below) would otherwise see a
  // stale, pre-scroll column range and think it's miles from the loaded
  // data — this gate holds that effect off until the scroll has actually
  // landed and React has re-rendered with the fresh positions.
  const settledRef = useRef(false);
  const [scrollGeneration, setScrollGeneration] = useState(0);

  const scrollToIndexSettled = useCallback(
    (index: number) => {
      settledRef.current = false;
      virtualizer.scrollToIndex(index, { align: "start" });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // `scrollToIndex(..., {align:"start"})` puts the target column's
          // left edge at viewport x=0 — but the sticky Room/Bed columns sit
          // on top of that same x=0, `labelColWidths.room + labelColWidths.
          // bed` px wide, so the target column (and often the next one too)
          // lands hidden underneath them. Nudging scrollLeft back by that
          // width afterwards (rather than folding it into the virtualizer's
          // own scroll math) lands the target column just past the frozen
          // columns without touching how the virtualizer tracks position.
          const vp = viewportRef.current;
          if (vp) vp.scrollLeft = Math.max(0, vp.scrollLeft - (labelColWidths.room + labelColWidths.bed));
          settledRef.current = true;
          setScrollGeneration((g) => g + 1);
        });
      });
    },
    [virtualizer, labelColWidths.room, labelColWidths.bed]
  );

  // Scroll to wherever staff last left the grid (see GridViewState), falling
  // back to "today" the first time there's nothing saved yet.
  useEffect(() => {
    const saved = readSavedGridViewState();
    if (saved) {
      (async () => {
        await jumpToDate(saved.date);
        // jumpToDate's own scroll (scrollToIndexSettled) finishes its
        // horizontal settling across two requestAnimationFrame callbacks,
        // not synchronously — setting scrollTop before those have run risks
        // it landing before layout has caught up to the new scrollWidth (a
        // wider/narrower loaded window than the one scrollTop was captured
        // against). Deferred the same two frames to land after that settles.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const vp = viewportRef.current;
            if (vp) vp.scrollTop = saved.scrollTop;
          });
        });
      })();
    } else {
      scrollToIndexSettled(nightsBetween(epochStart, today));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Continuously-updated record of "where the grid currently is" — read at
  // unmount to persist (see the effect below). Deliberately NOT computed
  // fresh inside that unmount cleanup itself: relying on viewportRef.current
  // and the virtualizer's live getVirtualItems() still being trustworthy at
  // the exact moment a component is torn down is the kind of thing that
  // works in dev and silently stops working after some unrelated React/
  // Next upgrade changes exactly when refs get detached relative to effect
  // cleanup. A plain ref updated on every real scroll event has no such
  // ordering dependency — by the time unmount happens, it's already holding
  // whatever the last real value was.
  const latestGridViewRef = useRef<GridViewState | null>(null);
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    function recordCurrentView() {
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) return;
      latestGridViewRef.current = { date: addDays(epochStart, items[0].index), scrollTop: vp!.scrollTop };
    }
    recordCurrentView();
    vp.addEventListener("scroll", recordCurrentView, { passive: true });
    return () => vp.removeEventListener("scroll", recordCurrentView);
  }, [virtualizer, epochStart]);

  // Save on the way out — covers both "clicked into a booking, then back"
  // and "switched to another nav tab, then back to Grid" (both unmount this
  // component; simply switching browser TABS does not, so there's nothing
  // to re-save there).
  useEffect(() => {
    return () => {
      if (latestGridViewRef.current) saveGridViewState(latestGridViewRef.current);
    };
  }, []);

  async function fetchWindow(start: ISODate, days: number) {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/grid?start=${start}&days=${days}`);
      if (!res.ok) throw new Error("Could not load the grid for that range.");
      const json: GridData = await res.json();
      if (fetchTokenRef.current === token) setData(json);
    } catch {
      if (fetchTokenRef.current === token) setError("Could not load the grid for that range.");
    } finally {
      if (fetchTokenRef.current === token) setLoading(false);
    }
  }

  const virtualColumns = virtualizer.getVirtualItems();

  // Shift the loaded window as the visible range approaches its edge —
  // fetch the next ~60-day stretch centered on what's currently visible and
  // drop the far side, rather than growing the window without bound.
  //
  // Recentering (not nudging by just the buffer amount) matters: a nudge
  // that trims the margin down to exactly EDGE_BUFFER_DAYS on the side that
  // triggered can leave the OTHER side just as thin, which re-triggers a
  // shift back the moment the fetch resolves — an infinite ping-pong
  // between two windows. Recentering maximises the margin on both sides
  // after every shift, and is self-limiting: once centered, re-running this
  // with an unchanged visible range recomputes the same window and the
  // no-op guard below stops it.
  useEffect(() => {
    if (!settledRef.current || loading || virtualColumns.length === 0) return;
    const visibleStart = virtualColumns[0].index;
    const visibleEnd = virtualColumns[virtualColumns.length - 1].index;
    const loadedEnd = dataStartIndex + data.days;

    const nearLeftEdge = visibleStart - dataStartIndex < EDGE_BUFFER_DAYS;
    const nearRightEdge = loadedEnd - visibleEnd < EDGE_BUFFER_DAYS;
    if (!nearLeftEdge && !nearRightEdge) return;

    const visibleCenter = Math.floor((visibleStart + visibleEnd) / 2);
    let newStartIndex = Math.max(0, visibleCenter - Math.floor(ROLLING_WINDOW_DAYS / 2));
    const newEndIndex = Math.min(totalColumns, newStartIndex + ROLLING_WINDOW_DAYS);
    newStartIndex = Math.max(0, newEndIndex - ROLLING_WINDOW_DAYS);
    const newDays = newEndIndex - newStartIndex;
    if (newStartIndex === dataStartIndex && newDays === data.days) return;

    fetchWindow(addDays(epochStart, newStartIndex), newDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualColumns.map((c) => c.index).join(","), loading, scrollGeneration]);

  async function jumpToDate(dateStr: ISODate) {
    const targetIndex = nightsBetween(epochStart, dateStr);
    if (targetIndex < 0 || targetIndex >= totalColumns) {
      setError("That date is outside the range this grid supports.");
      return;
    }
    if (targetIndex < dataStartIndex || targetIndex >= dataStartIndex + data.days) {
      const newStart = addDays(dateStr, -Math.floor(ROLLING_WINDOW_DAYS / 2));
      await fetchWindow(newStart, ROLLING_WINDOW_DAYS);
    }
    scrollToIndexSettled(targetIndex);
  }

  /**
   * The split-sibling « / » nav icons' click handler — jumps to the OTHER
   * part's date (same horizontal "land as the first visible column"
   * behaviour as jumpToDate) and then also brings its ROW into view and
   * flashes it, so the sibling isn't just technically on-screen somewhere
   * but is genuinely easy to spot — useful when there are several split
   * bookings in view at once and it's not obvious which one just moved.
   * Waits a couple of animation frames after the horizontal jump before
   * looking for the target pill in the DOM: jumpToDate's own data fetch is
   * awaited here, but React hasn't necessarily committed the resulting
   * re-render yet the instant that promise resolves.
   */
  async function jumpToSibling(bookingId: number, dateStr: ISODate) {
    await jumpToDate(dateStr);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = viewportRef.current?.querySelector<HTMLElement>(`[data-booking-id="${bookingId}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        flashHighlightBooking(bookingId);
      });
    });
  }

  // --- Drag-to-pan (both axes), disambiguated from clicks -------------------

  const dragRef = useRef<{ startX: number; startY: number; scrollLeft: number; scrollTop: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [panning, setPanning] = useState(false);

  // A raw pointermove can fire far more often than the browser actually
  // repaints (some mice/trackpads report well past 60Hz) — writing
  // scrollLeft/scrollTop straight from every event was doing that many
  // layout/scroll passes per frame, most of them immediately superseded by
  // the next one before ever reaching the screen. Collapsing to the latest
  // target and applying it once per animation frame cuts that down to
  // exactly the writes that actually get painted, which is what made
  // dragging feel heavy/sticky rather than a plain 1:1 tracking issue.
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const panRafRef = useRef<number | null>(null);

  const flushPanScroll = useCallback(() => {
    panRafRef.current = null;
    const pending = pendingScrollRef.current;
    const vp = viewportRef.current;
    if (!pending || !vp) return;
    vp.scrollLeft = pending.left;
    vp.scrollTop = pending.top;
  }, []);

  // Mouse-wheel/trackpad scrolling over this dense a grid, at the browser's
  // native (un-dampened) speed, flew past several days/rows per notch —
  // reported as "way too fast" compared to a normal page. Reusing the same
  // rAF-batched pendingScrollRef/flushPanScroll plumbing as drag-to-pan
  // above, just fed from wheel deltas scaled down by WHEEL_SCROLL_FACTOR
  // instead of 1:1 pointer movement. Attached as a real native listener
  // (not a React onWheel prop) with { passive: false } — React has attached
  // "wheel" as a passive root listener since v17 for scroll-perf reasons,
  // which silently ignores preventDefault() called from a plain JSX handler.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const current = pendingScrollRef.current ?? { left: vp!.scrollLeft, top: vp!.scrollTop };
      if (e.shiftKey) {
        // Shift+scroll pans left/right only, ignoring vertical entirely —
        // a plain mouse wheel only ever reports motion on deltaY (even held
        // with Shift, since we're not relying on the browser's own native
        // axis-swap — that only happens for the UNintercepted scroll we're
        // preventDefault-ing away here), so that's what actually drives the
        // pan; a trackpad's own real deltaX (e.g. a diagonal swipe) is
        // honoured too if present, in case both arrive on the same event.
        const horizontalDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        pendingScrollRef.current = { left: current.left + horizontalDelta * WHEEL_SCROLL_FACTOR, top: current.top };
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Without Shift, a genuine two-finger left/right trackpad swipe
        // (deltaX dominant) still pans the grid horizontally, same as any
        // normal scrollable page — only Shift is required for a plain mouse
        // wheel, which never reports deltaX at all.
        pendingScrollRef.current = { left: current.left + e.deltaX * WHEEL_SCROLL_FACTOR, top: current.top };
      } else {
        // Otherwise vertical — a trackpad's incidental sideways drift on an
        // otherwise-vertical swipe still doesn't also nudge the grid
        // horizontally.
        pendingScrollRef.current = { left: current.left, top: current.top + e.deltaY * WHEEL_SCROLL_FACTOR };
      }
      if (panRafRef.current == null) panRafRef.current = requestAnimationFrame(flushPanScroll);
    }
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [flushPanScroll]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const vp = viewportRef.current;
    if (!vp) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, scrollLeft: vp.scrollLeft, scrollTop: vp.scrollTop, dragging: false };
    vp.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const ds = dragRef.current;
      const vp = viewportRef.current;
      if (!ds || !vp) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (!ds.dragging && Math.hypot(dx, dy) > 5) {
        ds.dragging = true;
        setPanning(true);
      }
      if (ds.dragging) {
        e.preventDefault();
        pendingScrollRef.current = { left: ds.scrollLeft - dx, top: ds.scrollTop - dy };
        if (panRafRef.current == null) panRafRef.current = requestAnimationFrame(flushPanScroll);
      }
    },
    [flushPanScroll]
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const ds = dragRef.current;
    if (ds?.dragging) {
      suppressClickRef.current = true;
      setPanning(false);
    }
    dragRef.current = null;
    if (panRafRef.current != null) {
      cancelAnimationFrame(panRafRef.current);
      panRafRef.current = null;
    }
    pendingScrollRef.current = null;
    viewportRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressClickRef.current = false;
    }
  }, []);

  // Belt-and-suspenders for the booking-pill drag (see onPillPointerDown /
  // clearPillDragVisuals): the pill's own onPointerUp/onPointerCancel handle
  // the normal case, but if pointer capture is ever lost some other way
  // (window loses focus mid-drag, browser quirk) those never fire on the
  // pill itself, leaving the green drop-target outline and dimmed pill
  // stuck until a refresh. These window-level listeners are a global
  // fallback that always runs, regardless of what element has capture.
  useEffect(() => {
    window.addEventListener("pointerup", clearPillDragVisuals);
    window.addEventListener("pointercancel", clearPillDragVisuals);
    window.addEventListener("blur", clearPillDragVisuals);
    window.addEventListener("pointerup", clearEventDragVisuals);
    window.addEventListener("pointercancel", clearEventDragVisuals);
    window.addEventListener("blur", clearEventDragVisuals);
    return () => {
      window.removeEventListener("pointerup", clearPillDragVisuals);
      window.removeEventListener("pointercancel", clearPillDragVisuals);
      window.removeEventListener("blur", clearPillDragVisuals);
      window.removeEventListener("pointerup", clearEventDragVisuals);
      window.removeEventListener("pointercancel", clearEventDragVisuals);
      window.removeEventListener("blur", clearEventDragVisuals);
    };
  }, []);

  // Kept in sync with the loaded grid so the drag collision check (see
  // conflictingBookings) always answers against the current data, not a
  // stale snapshot from when the drag started.
  useEffect(() => {
    occupancyIndex = buildOccupancyIndex(data.grid, data.dates);
    bedCapacityIndex = buildBedCapacityIndex(data.grid);
  }, [data]);

  // --- Toasts -----------------------------------------------------------

  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  function pushToast(text: string) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // --- Auto-allocate (manual, from the "Needs a bed" panel) --------------

  const [autoAllocating, setAutoAllocating] = useState(false);
  const [allocatingId, setAllocatingId] = useState<number | "bulk" | null>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [movesMenuOpen, setMovesMenuOpen] = useState(false);
  // settingsMenuOpen/hoveredPreviewToggle/previewNameWidth used to live here
  // but were purely local to the Display-settings dropdown's own UI — kept
  // as state on the whole GridCanvas component, every hover/toggle inside
  // that small menu forced React to reconcile the ENTIRE grid (rows aren't
  // memoized/virtualized, only columns are — see virtualColumns), which is
  // what made the preview feel slow to appear on any property with a lot of
  // rows. Moved into GridSettingsMenu below so that re-render is scoped to
  // just the dropdown itself.
  // Per-browser display preference, not per-user account data — a plain
  // "how do I want to look at the grid" toggle has no reason to round-trip
  // through the server or follow someone between machines. Read once on
  // mount (SSR has no localStorage, so this starts true — the pre-toggle
  // default — and settles to the real stored value on the client's first
  // render); more toggles can join this same object later.
  const [showSharesWithText, setShowSharesWithText] = useState(true);
  // Whether hovering a pill shows the "GuestName - arrival to departure"
  // native-style tooltip (see the pill <td>'s own data-tooltip) — on by
  // default (matches the long-standing behaviour), but some staff find it
  // noisy once they already know the grid well.
  const [showHoverDetails, setShowHoverDetails] = useState(true);
  // How much of a booking's name its pill shows — see pillDisplayName's own
  // doc comment for the three modes.
  const [pillNameMode, setPillNameMode] = useState<PillNameMode>("first");
  useEffect(() => {
    const stored = localStorage.getItem("tr-grid-settings");
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored);
      if (typeof parsed.showSharesWithText === "boolean") setShowSharesWithText(parsed.showSharesWithText);
      if (typeof parsed.showHoverDetails === "boolean") setShowHoverDetails(parsed.showHoverDetails);
      if (parsed.pillNameMode === "first" || parsed.pillNameMode === "firstInitial" || parsed.pillNameMode === "firstLast") {
        setPillNameMode(parsed.pillNameMode);
      }
    } catch {
      // Corrupt/foreign value — ignore, keep the default.
    }
  }, []);
  // Every setter merges into the same stored object (reading the CURRENT
  // state values, not just the one being changed) rather than each
  // overwriting the whole "tr-grid-settings" key — otherwise changing one
  // setting would silently reset the others back to default the next time
  // this loads.
  function updateShowSharesWithText(value: boolean) {
    setShowSharesWithText(value);
    localStorage.setItem("tr-grid-settings", JSON.stringify({ showSharesWithText: value, showHoverDetails, pillNameMode }));
  }
  function updateShowHoverDetails(value: boolean) {
    setShowHoverDetails(value);
    localStorage.setItem("tr-grid-settings", JSON.stringify({ showSharesWithText, showHoverDetails: value, pillNameMode }));
  }
  function updatePillNameMode(value: PillNameMode) {
    setPillNameMode(value);
    localStorage.setItem("tr-grid-settings", JSON.stringify({ showSharesWithText, showHoverDetails, pillNameMode: value }));
  }
  const [cancellingMoveId, setCancellingMoveId] = useState<string | "all" | null>(null);
  const [fixOpenGroupId, setFixOpenGroupId] = useState<number | null>(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [fixOptions, setFixOptions] = useState<RoomFixOption[] | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const [applyingFixRoomId, setApplyingFixRoomId] = useState<number | null>(null);
  const [fixingAll, setFixingAll] = useState(false);

  async function toggleGroupFix(bookingId: number) {
    if (fixOpenGroupId === bookingId) {
      setFixOpenGroupId(null);
      return;
    }
    setFixOpenGroupId(bookingId);
    setFixOptions(null);
    setFixError(null);
    setFixLoading(true);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/allocation-fix-options`);
      if (!res.ok) {
        setFixError("Could not load fix options.");
        return;
      }
      const body: { options: RoomFixOption[] } = await res.json();
      setFixOptions(body.options);
    } finally {
      setFixLoading(false);
    }
  }

  async function applyGroupFixOption(option: RoomFixOption) {
    setApplyingFixRoomId(option.roomId);
    setFixError(null);
    try {
      // Captured before the move, so undo has somewhere to put things back
      // — both the group's own beds AND, separately, whoever got evicted to
      // make room. A split eviction still creates a brand-new booking row
      // server-side; that new id comes back in the response below, since
      // there's no way to know it ahead of time from the client.
      const before = await Promise.all(
        option.moves.map(async (m) => {
          const b: { bedId: number | null } = await fetch(`/api/bookings/${m.bookingId}`).then((r) => r.json());
          return { bookingId: m.bookingId, bedId: b.bedId };
        })
      );

      const res = await fetch("/api/bookings/auto-allocate/apply-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves: option.moves, rejoins: option.rejoins, evictions: option.evictions }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFixError(body.error ?? "Could not apply that move.");
        return;
      }
      const applyBody: {
        evictionResults: { bookingId: number; previousBedId: number | null; previousDepartureDate?: ISODate; createdBookingId?: number }[];
        closedJoins: { id: number; bed1Id: number; bed2Id: number; mode: "double" | "solo"; startDate: ISODate; endDate: ISODate | null; deleted: boolean }[];
        createdJoins: { id: number; bed1Id: number; bed2Id: number }[];
      } = await res.json();
      setFixOpenGroupId(null);
      const names = [...new Set(option.moves.map((m) => m.guestName))];
      pushToast(`Moved ${names.join(", ")} to ${option.roomName}.`);
      await refreshCurrentWindow();
      pushHistory({
        label: `Move ${names.join(", ")} to ${option.roomName}`,
        undo: async () => {
          for (const b of before) await apiPatch(`/api/bookings/${b.bookingId}`, { bedId: b.bedId });
          for (const ev of applyBody.evictionResults) {
            if (ev.createdBookingId != null) await apiDelete(`/api/bookings/${ev.createdBookingId}`);
            const patch: { bedId: number | null; departureDate?: ISODate } = { bedId: ev.previousBedId };
            if (ev.previousDepartureDate != null) patch.departureDate = ev.previousDepartureDate;
            await apiPatch(`/api/bookings/${ev.bookingId}`, patch);
          }
          // A "Fix" that pairs two movers into a couple double (rejoins)
          // creates a brand-new join row, and moving a booking OFF a bed
          // that had an active join closes that join as a side effect —
          // neither of those was previously reversed, which is exactly why
          // undo used to put the bookings back but leave the bed-type
          // change (2 singles <-> couple double) in place.
          for (const cj of applyBody.createdJoins) await apiDelete(`/api/joined-beds/${cj.id}`);
          for (const cj of applyBody.closedJoins) {
            if (cj.deleted) {
              await apiPost("/api/joined-beds", { bed1Id: cj.bed1Id, bed2Id: cj.bed2Id, mode: cj.mode, startDate: cj.startDate, endDate: cj.endDate });
            } else {
              await apiPatch(`/api/joined-beds/${cj.id}`, { endDate: cj.endDate });
            }
          }
          await refreshCurrentWindow();
        },
        redo: async () => {
          await apiPost("/api/bookings/auto-allocate/apply-move", { moves: option.moves, rejoins: option.rejoins, evictions: option.evictions });
          await refreshCurrentWindow();
        },
      });
    } finally {
      setApplyingFixRoomId(null);
    }
  }

  /**
   * Applies every allocation issue's own cheapest fix, one group at a time
   * (sequential, not parallel — fixing one group can change what's
   * available for the next, so each fetch/apply pair must see the other's
   * result). "Cheapest" = fewest evictions, since every option for a group
   * already relocates the same people; evictions are the only thing that
   * varies, and displacing fewer other guests is "the least moves."
   */
  async function runFixAll() {
    setFixingAll(true);
    try {
      for (const g of data.issueGroups) {
        const res = await fetch(`/api/bookings/${g.bookingId}/allocation-fix-options`);
        if (!res.ok) continue;
        const body: { options: RoomFixOption[] } = await res.json();
        if (!body.options || body.options.length === 0) continue;
        const cheapest = [...body.options].sort((a, b) => a.evictions.length - b.evictions.length)[0];
        await applyGroupFixOption(cheapest);
      }
    } finally {
      setFixingAll(false);
    }
  }

  const [moveProposals, setMoveProposals] = useState<GroupMoveProposal[]>([]);
  const [applyingProposalKey, setApplyingProposalKey] = useState<string | null>(null);

  async function runAutoAllocate(bookingId?: number) {
    setAutoAllocating(true);
    setAllocatingId(bookingId ?? "bulk");
    try {
      const res = await fetch("/api/bookings/auto-allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookingId != null ? { bookingId } : { withinDays: 7 }),
      });
      if (!res.ok) {
        pushToast("Could not auto-allocate — please try again.");
        return;
      }
      const body: {
        assigned: { id: number; guestName: string; bedId: number; roomName: string }[];
        skipped: { guestName: string; reason: string }[];
        proposals: GroupMoveProposal[];
      } = await res.json();
      const parts = [`Assigned ${body.assigned.length} booking${body.assigned.length === 1 ? "" : "s"}`];
      if (body.skipped.length > 0) parts.push(`${body.skipped.length} still need${body.skipped.length === 1 ? "s" : ""} a bed`);
      pushToast(parts.join(", ") + ".");
      setMoveProposals(body.proposals ?? []);
      await fetchWindow(data.start, data.days);
      if (body.assigned.length > 0) {
        const label = body.assigned.length === 1 ? `Allocate ${body.assigned[0].guestName}` : `Auto-allocate ${body.assigned.length} bookings`;
        pushHistory({
          label,
          // Every assigned booking was unassigned beforehand by definition
          // (auto-allocate only ever touches bookings with no bed yet), so
          // undo is always a plain reset to null — no prior state to look
          // up. Redo re-applies the SAME bed choice rather than re-running
          // the search, so it can't land somewhere different the second
          // time round.
          undo: async () => {
            for (const a of body.assigned) await apiPatch(`/api/bookings/${a.id}`, { bedId: null });
            await refreshCurrentWindow();
          },
          redo: async () => {
            for (const a of body.assigned) await apiPatch(`/api/bookings/${a.id}`, { bedId: a.bedId });
            await refreshCurrentWindow();
          },
        });
      }
    } finally {
      setAutoAllocating(false);
      setAllocatingId(null);
    }
  }

  async function confirmMoveProposal(proposal: GroupMoveProposal) {
    setApplyingProposalKey(proposal.key);
    try {
      const res = await fetch("/api/bookings/auto-allocate/apply-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moves: proposal.moves, rejoinBookingIds: proposal.rejoinBookingIds }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        pushToast(errBody.error ?? "Could not apply that move — please try again.");
        return;
      }
      setMoveProposals((prev) => prev.filter((p) => p.key !== proposal.key));
      pushToast(`Moved ${proposal.guestNames.join(", ")} to ${proposal.toRoomName}.`);
      await fetchWindow(data.start, data.days);
    } finally {
      setApplyingProposalKey(null);
    }
  }

  function declineMoveProposal(key: string) {
    setMoveProposals((prev) => prev.filter((p) => p.key !== key));
  }

  function notifyUnassigned(unassignedBookings: UnassignedBooking[] | undefined) {
    if (!unassignedBookings || unassignedBookings.length === 0) return;
    const names = unassignedBookings.map((b) => `${b.guestName} (${formatDateUk(b.arrivalDate)} to ${formatDateUk(b.departureDate)})`).join(", ");
    pushToast(
      `This layout change conflicts with ${unassignedBookings.length} existing booking${unassignedBookings.length === 1 ? "" : "s"} — moved to unallocated: ${names}`
    );
  }

  // --- Right-click lifecycle: join / switch / split ----------------------

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [bedActionModal, setBedActionModal] = useState<BedActionModalState | null>(null);
  const [joinActionModal, setJoinActionModal] = useState<JoinActionModalState | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinConflictModal, setJoinConflictModal] = useState<
    (JoinConflictModalState & { retry: (resolution: "overwrite" | "trim") => Promise<boolean> }) | null
  >(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [splitMergeConflict, setSplitMergeConflict] = useState<SplitMergeConflictModalState | null>(null);
  const [plannedChangeConflict, setPlannedChangeConflict] = useState<
    (PlannedChangeConflictModalState & { lines: PlannedChangeLine[]; id: string | "all" }) | null
  >(null);

  async function mergeSplitBooking(bookingId: number) {
    const res = await fetch(`/api/bookings/${bookingId}/merge-split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && Array.isArray(body.conflicts)) {
      setSplitMergeConflict({ bookingId, conflicts: body.conflicts, canSwap: !!body.canSwap });
      return;
    }
    if (!res.ok) {
      setError(body.error ?? "Could not merge.");
      return;
    }
    pushToast(body.applied ? "Merged onto this bed." : "Already all on this bed.");
    await refreshCurrentWindow();
  }

  async function resolveSplitMergeConflict(resolution: "swap" | "unallocate") {
    if (!splitMergeConflict) return;
    const res = await fetch(`/api/bookings/${splitMergeConflict.bookingId}/merge-split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution }),
    });
    setSplitMergeConflict(null);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not merge.");
      return;
    }
    pushToast("Merged onto this bed.");
    await refreshCurrentWindow();
  }

  function openMenu(e: React.MouseEvent, title: string, items: ContextMenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, title, items });
  }

  async function apiPost<T = { unassignedBookings?: UnassignedBooking[] }>(url: string, body: unknown): Promise<T | null> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return null;
    }
    return res.json();
  }

  async function apiPatch(url: string, body: unknown): Promise<boolean> {
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return false;
    }
    return true;
  }

  async function apiDelete(url: string): Promise<boolean> {
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return false;
    }
    return true;
  }

  async function cancelPlannedChangeLines(lines: PlannedChangeLine[], id: string | "all", confirmed = false) {
    setCancellingMoveId(id);
    const bedLocationIds = lines.flatMap((l) => l.bedLocationIds);
    const joinCancellations = lines
      .filter((l) => l.kind !== "move")
      .flatMap((l) => l.joinedBedIds.map((jid) => ({ id: jid, kind: l.kind === "join-start" ? ("start" as const) : ("end" as const) })));

    const res = await fetch("/api/bed-moves", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bedLocationIds, joinCancellations, confirmed }),
    });
    // Some booking already assumes this change will happen (see
    // findBookingsAffectedByCancel) — ask before cancelling out from under
    // it, instead of silently leaving that booking pointing at a room/bed
    // configuration nobody set up. Deliberately neutral between cancelling
    // and delaying — see PlannedChangeConflictModal's own doc comment for
    // why the data alone can't say which one staff actually want.
    if (res.status === 409) {
      const b: { affected?: { bookingId: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate }[]; pushedDate?: ISODate } =
        await res.json().catch(() => ({}));
      setCancellingMoveId(null);
      if (b.affected && b.affected.length > 0 && b.pushedDate) {
        setPlannedChangeConflict({
          lines,
          id,
          affected: b.affected,
          pushedDate: b.pushedDate,
          configDescription: plannedChangeConfigDescription(lines),
        });
      }
      return;
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      setCancellingMoveId(null);
      return;
    }
    const body: {
      cancelled: { bedId: number; fromRoomId: number; toRoomId: number; startDate: ISODate; endDate: ISODate | null }[];
      cancelledJoins: { id: number; kind: "start" | "end"; bed1Id: number; bed2Id: number; mode: "double" | "solo"; startDate: ISODate; endDate: ISODate | null }[];
    } = await res.json();
    await refreshCurrentWindow();
    if (body.cancelled.length > 0 || body.cancelledJoins.length > 0) {
      // A join-start's undo has to RECREATE the row (it was deleted
      // outright), which mints a new id every time — captured here so a
      // subsequent redo knows which row to delete again. A join-end's undo
      // only ever PATCHes the SAME row's endDate back and forth, so its id
      // never changes and needs no such tracking.
      const recreatedJoinIds: (number | null)[] = new Array(body.cancelledJoins.length).fill(null);
      pushHistory({
        label: id === "all" ? "Cancel all planned changes" : "Cancel planned change",
        undo: async () => {
          for (const c of body.cancelled) {
            await apiPost("/api/bed-locations", { bedId: c.bedId, roomId: c.toRoomId, startDate: c.startDate, endDate: c.endDate });
          }
          for (let i = 0; i < body.cancelledJoins.length; i++) {
            const cj = body.cancelledJoins[i];
            if (cj.kind === "start") {
              const created = await apiPost<{ id: number }>("/api/joined-beds", {
                bed1Id: cj.bed1Id,
                bed2Id: cj.bed2Id,
                mode: cj.mode,
                startDate: cj.startDate,
                endDate: cj.endDate,
              });
              recreatedJoinIds[i] = created?.id ?? null;
            } else {
              await apiPatch(`/api/joined-beds/${cj.id}`, { endDate: cj.endDate });
            }
          }
          await refreshCurrentWindow();
        },
        redo: async () => {
          for (const c of body.cancelled) {
            await apiPost("/api/bed-locations", { bedId: c.bedId, roomId: c.fromRoomId, startDate: c.startDate });
          }
          for (let i = 0; i < body.cancelledJoins.length; i++) {
            const cj = body.cancelledJoins[i];
            if (cj.kind === "start") {
              const rid = recreatedJoinIds[i];
              if (rid != null) await apiDelete(`/api/joined-beds/${rid}`);
            } else {
              await apiPatch(`/api/joined-beds/${cj.id}`, { endDate: null });
            }
          }
          await refreshCurrentWindow();
        },
      });
    }
    setCancellingMoveId(null);
  }

  /** The "Delay" resolution from PlannedChangeConflictModal — see that component's own doc comment for why this exists alongside cancelling outright. */
  async function delayPlannedChangeLines(lines: PlannedChangeLine[], id: string | "all") {
    setCancellingMoveId(id);
    const bedLocationIds = lines.flatMap((l) => l.bedLocationIds);
    const joinCancellations = lines
      .filter((l) => l.kind !== "move")
      .flatMap((l) => l.joinedBedIds.map((jid) => ({ id: jid, kind: l.kind === "join-start" ? ("start" as const) : ("end" as const) })));

    const res = await fetch("/api/bed-moves", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bedLocationIds, joinCancellations, action: "delay" }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      setCancellingMoveId(null);
      return;
    }
    const body: {
      delayed: { bedId: number; toRoomId: number; originalStartDate: ISODate; originalEndDate: ISODate | null; pushedDate: ISODate }[];
      delayedJoins: { id: number; kind: "start" | "end"; originalDate: ISODate | null; pushedDate: ISODate }[];
    } = await res.json();
    await refreshCurrentWindow();
    pushHistory({
      label: id === "all" ? "Delay all planned changes" : "Delay planned change",
      undo: async () => {
        for (const d of body.delayed) {
          await apiPost("/api/bed-locations", { bedId: d.bedId, roomId: d.toRoomId, startDate: d.originalStartDate, endDate: d.originalEndDate });
        }
        for (const dj of body.delayedJoins) {
          if (dj.originalDate == null) continue;
          if (dj.kind === "start") await apiPatch(`/api/joined-beds/${dj.id}`, { startDate: dj.originalDate });
          else await apiPatch(`/api/joined-beds/${dj.id}`, { endDate: dj.originalDate });
        }
        await refreshCurrentWindow();
      },
      redo: async () => {
        for (const d of body.delayed) {
          await apiPost("/api/bed-locations", { bedId: d.bedId, roomId: d.toRoomId, startDate: d.pushedDate, endDate: d.originalEndDate });
        }
        for (const dj of body.delayedJoins) {
          if (dj.kind === "start") await apiPatch(`/api/joined-beds/${dj.id}`, { startDate: dj.pushedDate });
          else await apiPatch(`/api/joined-beds/${dj.id}`, { endDate: dj.pushedDate });
        }
        await refreshCurrentWindow();
      },
    });
    setCancellingMoveId(null);
  }

  async function resolvePlannedChangeConflict(resolution: "cancel" | "delay") {
    if (!plannedChangeConflict) return;
    const { lines, id } = plannedChangeConflict;
    setPlannedChangeConflict(null);
    if (resolution === "cancel") await cancelPlannedChangeLines(lines, id, true);
    else await delayPlannedChangeLines(lines, id);
  }

  async function refreshCurrentWindow() {
    await fetchWindow(data.start, data.days);
  }

  // --- Undo/Redo -----------------------------------------------------------
  //
  // Every action below that mutates the schedule pushes a HistoryEntry whose
  // undo/redo call the low-level apiPost/apiPatch/apiDelete helpers DIRECTLY
  // — never `actions.*` itself, which would push a NEW history entry for the
  // undo and corrupt the stack. Each entry carries the exact reverse payload
  // (old bed id, old dates, a full booking snapshot, …) captured at the
  // moment the action ran, not re-derived later from whatever the grid
  // happens to show — that's what keeps undo correct even several steps
  // back. moveBed's reverse re-places the bed in its previous room as of
  // the SAME effective date (see BedActionModalState.previousRoomId,
  // captured at the moment the modal opens) — correct for the common case
  // of undoing immediately after, though not a full point-in-time history
  // reconstruction if other bed_locations changes happened in between.
  interface HistoryEntry {
    id: number;
    label: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }

  const MAX_HISTORY = 20;
  const [historyPast, setHistoryPast] = useState<HistoryEntry[]>([]);
  const [historyFuture, setHistoryFuture] = useState<HistoryEntry[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyIdRef = useRef(0);

  function pushHistory(entry: Omit<HistoryEntry, "id">) {
    const full: HistoryEntry = { id: historyIdRef.current++, ...entry };
    setHistoryPast((prev) => {
      const next = [...prev, full];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setHistoryFuture([]);
  }

  async function undo() {
    if (historyBusy || historyPast.length === 0) return;
    const entry = historyPast[historyPast.length - 1];
    setHistoryBusy(true);
    setHistoryPast((prev) => prev.slice(0, -1));
    try {
      await entry.undo();
    } finally {
      setHistoryFuture((prev) => [...prev, entry]);
      setHistoryBusy(false);
    }
  }

  async function redo() {
    if (historyBusy || historyFuture.length === 0) return;
    const entry = historyFuture[historyFuture.length - 1];
    setHistoryBusy(true);
    setHistoryFuture((prev) => prev.slice(0, -1));
    try {
      await entry.redo();
    } finally {
      setHistoryPast((prev) => [...prev, entry]);
      setHistoryBusy(false);
    }
  }

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z to redo — skipped
  // while focus is in a text field (the "Jump to" date input, any future
  // form field) so it doesn't fight normal text editing/selection.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyPast, historyFuture, historyBusy]);

  const actions = useMemo(
    () => ({
      openMenu,
      async joinAsNew(
        bed1Id: number,
        bed2Id: number,
        mode: "double" | "solo",
        startDate: ISODate,
        endDate: ISODate | null,
        resolution?: "overwrite" | "trim"
      ) {
        // Raw fetch (not apiPost) — a 409 here carries a structured
        // `conflict`/`futureConflict` payload (see POST /api/joined-beds)
        // that needs its own handling, not the generic error banner every
        // other action falls back to.
        const res = await fetch("/api/joined-beds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bed1Id, bed2Id, mode, startDate, endDate, resolution }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (body.futureConflict) {
            // A GENUINE future collision for this exact bed pair — ask the
            // user to choose rather than silently trimming (see
            // JoinConflictModal). Re-invokes this same action with the
            // chosen resolution once they pick.
            const futureConflict = body.futureConflict as { startDate: ISODate };
            setJoinConflictModal({
              conflictStartDate: futureConflict.startDate,
              retry: (chosen) => actions.joinAsNew(bed1Id, bed2Id, mode, startDate, endDate, chosen),
            });
          } else if (body.conflict) {
            const conflict = body.conflict as { startDate: ISODate; endDate: ISODate | null };
            pushToast(
              `Conflict: Already joined from ${formatDateUk(conflict.startDate)} to ${conflict.endDate ? formatDateUk(conflict.endDate) : "indefinitely"}`
            );
          } else {
            setJoinError(body.error ?? "Something went wrong.");
          }
          return false;
        }
        setJoinError(null);
        notifyUnassigned(body.unassignedBookings);
        // With no explicit resolution requested (no prior collision), the
        // server may still have silently trimmed the end date against a
        // DIFFERENT-partner conflict — that path is unchanged/out of scope,
        // so still surface it here.
        if (!resolution && (endDate ?? null) !== (body.endDate ?? null) && body.endDate) {
          pushToast(`Joined ${formatDateUk(startDate)} onward — trimmed to end ${formatDateUk(body.endDate)}, right before an existing later join.`);
        }
        await refreshCurrentWindow();
        let currentJoinId: number | undefined = body.id;
        const overwrittenJoin = body.overwrittenJoin as
          | { bed1Id: number; bed2Id: number; startDate: ISODate; endDate: ISODate | null; mode: "double" | "solo" }
          | null
          | undefined;
        pushHistory({
          label: `Join beds as ${mode === "solo" ? "Solo" : "Couple"} Double`,
          undo: async () => {
            if (currentJoinId != null) await apiDelete(`/api/joined-beds/${currentJoinId}`);
            // Overwriting deleted a future join for these same beds outright
            // — undo must bring it back exactly as it was, not just remove
            // the new one, or that scheduled join silently vanishes.
            if (overwrittenJoin) {
              await apiPost("/api/joined-beds", {
                bed1Id: overwrittenJoin.bed1Id,
                bed2Id: overwrittenJoin.bed2Id,
                mode: overwrittenJoin.mode,
                startDate: overwrittenJoin.startDate,
                endDate: overwrittenJoin.endDate,
              });
            }
            await refreshCurrentWindow();
          },
          redo: async () => {
            const r = await apiPost<{ id: number }>("/api/joined-beds", { bed1Id, bed2Id, mode, startDate, endDate, resolution });
            currentJoinId = r?.id;
            await refreshCurrentWindow();
          },
        });
        return true;
      },
      async switchJoinMode(bed1Id: number, bed2Id: number, atDate: ISODate, mode: "double" | "solo") {
        const oldMode: "double" | "solo" = mode === "double" ? "solo" : "double";
        const result = await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode });
        if (!result) return;
        notifyUnassigned(result.unassignedBookings);
        await refreshCurrentWindow();
        pushHistory({
          label: `Switch to ${mode === "double" ? "Couple" : "Solo"} Double`,
          undo: async () => {
            await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode: oldMode });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/joined-beds/switch", { bed1Id, bed2Id, atDate, mode });
            await refreshCurrentWindow();
          },
        });
      },
      async splitJoin(bed1Id: number, bed2Id: number, atDate: ISODate) {
        // Capture the exact segment being split BEFORE splitting it, so undo
        // can recreate it precisely (not just "a" join, THIS join's dates/mode).
        const listRes = await fetch("/api/joined-beds");
        const list: Array<{ bed1Id: number; bed2Id: number; startDate: ISODate; endDate: ISODate | null; mode: "double" | "solo" }> =
          listRes.ok ? await listRes.json() : [];
        const active = list.find(
          (j) =>
            ((j.bed1Id === bed1Id && j.bed2Id === bed2Id) || (j.bed1Id === bed2Id && j.bed2Id === bed1Id)) &&
            j.startDate <= atDate &&
            (j.endDate == null || j.endDate > atDate)
        );

        const result = await apiPost("/api/joined-beds/split", { bed1Id, bed2Id, atDate });
        if (!result) return;
        await refreshCurrentWindow();
        if (!active) return;
        pushHistory({
          label: "Split into Singles",
          undo: async () => {
            await apiPost("/api/joined-beds", {
              bed1Id: active.bed1Id,
              bed2Id: active.bed2Id,
              mode: active.mode,
              startDate: active.startDate,
              endDate: active.endDate,
            });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/joined-beds/split", { bed1Id, bed2Id, atDate });
            await refreshCurrentWindow();
          },
        });
      },
      async goSolo(bedId: number, atDate: ISODate) {
        const result = await apiPost("/api/bed-solo-periods", { bedId, startDate: atDate });
        if (!result) return;
        notifyUnassigned(result.unassignedBookings);
        await refreshCurrentWindow();
        pushHistory({
          label: "Switch to Solo",
          undo: async () => {
            await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bed-solo-periods", { bedId, startDate: atDate });
            await refreshCurrentWindow();
          },
        });
      },
      async goCouple(bedId: number, atDate: ISODate) {
        const listRes = await fetch("/api/bed-solo-periods");
        const list: Array<{ bedId: number; startDate: ISODate; endDate: ISODate | null }> = listRes.ok ? await listRes.json() : [];
        const active = list.find((p) => p.bedId === bedId && p.startDate <= atDate && (p.endDate == null || p.endDate > atDate));

        const result = await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
        if (!result) return;
        await refreshCurrentWindow();
        if (!active) return;
        pushHistory({
          label: "Switch to Couple",
          undo: async () => {
            await apiPost("/api/bed-solo-periods", { bedId, startDate: active.startDate, endDate: active.endDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bed-solo-periods/split", { bedId, atDate });
            await refreshCurrentWindow();
          },
        });
      },
      // Confirmation happens in the caller (see bookingCellMenuItems' Delete
      // Booking item, which opens ConfirmModal before this ever runs) —
      // this only does the actual delete + undo/redo bookkeeping.
      async cancelBooking(bookingId: number, guestName: string) {
        const snapshotRes = await fetch(`/api/bookings/${bookingId}`);
        const snapshot = snapshotRes.ok ? await snapshotRes.json() : null;
        if (!(await apiDelete(`/api/bookings/${bookingId}`))) return;
        await refreshCurrentWindow();
        if (!snapshot) return;
        // Recreating on undo gets a NEW row id — this closure variable (not
        // the original bookingId) is what redo/a later undo must target.
        let currentId = bookingId;
        pushHistory({
          label: `Delete ${guestName}'s booking`,
          undo: async () => {
            const res = await fetch("/api/bookings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                guestName: snapshot.guestName,
                arrivalDate: snapshot.arrivalDate,
                departureDate: snapshot.departureDate,
                linkedBookingId: snapshot.linkedBookingId,
                bedId: snapshot.bedId,
                dietariesTags: snapshot.dietariesTags,
              }),
            });
            if (res.ok) currentId = (await res.json()).id;
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiDelete(`/api/bookings/${currentId}`);
            await refreshCurrentWindow();
          },
        });
      },
      async splitBooking(bookingId: number, splitDate: ISODate, guestName: string, originalDeparture: ISODate) {
        // Captured so undo can put splitGroupId back exactly as it was —
        // null if this was the booking's first-ever split (undo should
        // fully un-mark it as part of a lineage), or unchanged if it was
        // already a piece of an earlier split.
        const before: { splitGroupId: number | null } = await fetch(`/api/bookings/${bookingId}`).then((r) => r.json());
        const result = await apiPost<{ updated: { id: number }; created: { id: number } }>(
          `/api/bookings/${bookingId}/split`,
          { splitDate }
        );
        if (!result) return;
        await refreshCurrentWindow();
        // Recreating on redo gets a NEW row id — this closure variable (not
        // the id from the first split) is what undo/a later redo must target.
        let currentNewId = result.created.id;
        pushHistory({
          label: `Split ${guestName}'s booking on ${formatDateUk(splitDate)}`,
          undo: async () => {
            await apiDelete(`/api/bookings/${currentNewId}`);
            await apiPatch(`/api/bookings/${bookingId}`, { departureDate: originalDeparture, splitGroupId: before.splitGroupId });
            await refreshCurrentWindow();
          },
          redo: async () => {
            const r = await apiPost<{ updated: { id: number }; created: { id: number } }>(
              `/api/bookings/${bookingId}/split`,
              { splitDate }
            );
            if (r) currentNewId = r.created.id;
            await refreshCurrentWindow();
          },
        });
      },
      async mergeBookings(departingBookingId: number, arrivingBookingId: number, guestName: string) {
        const result = await apiPost<{
          updated: { id: number; departureDate: ISODate };
          deletedSnapshot: {
            id: number;
            guestName: string;
            arrivalDate: ISODate;
            departureDate: ISODate;
            linkedBookingId: number | null;
            bedId: number | null;
            dietariesTags: unknown;
          };
        }>(`/api/bookings/${departingBookingId}/merge`, { otherBookingId: arrivingBookingId });
        if (!result) return;
        await refreshCurrentWindow();
        // The reverse of splitBooking: the earlier (departing) booking
        // keeps its own id and absorbs the later one's dates; the later
        // booking is deleted. `splitPoint` (the deleted booking's own
        // arrivalDate) is exactly what the earlier booking's departureDate
        // was BEFORE this merge, since they were required to be
        // back-to-back — that's what undo reverts it to.
        const keptId = result.updated.id;
        const splitPoint = result.deletedSnapshot.arrivalDate;
        // Recreating on undo gets a NEW row id — this closure variable is
        // what a later redo must target.
        let currentLaterId: number | undefined;
        pushHistory({
          label: `Merge ${guestName}'s bookings`,
          undo: async () => {
            await apiPatch(`/api/bookings/${keptId}`, { departureDate: splitPoint });
            const res = await fetch("/api/bookings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                guestName: result.deletedSnapshot.guestName,
                arrivalDate: result.deletedSnapshot.arrivalDate,
                departureDate: result.deletedSnapshot.departureDate,
                linkedBookingId: result.deletedSnapshot.linkedBookingId,
                bedId: result.deletedSnapshot.bedId,
                dietariesTags: result.deletedSnapshot.dietariesTags,
              }),
            });
            if (res.ok) currentLaterId = (await res.json()).id;
            await refreshCurrentWindow();
          },
          redo: async () => {
            if (currentLaterId == null) return;
            await apiPost(`/api/bookings/${keptId}/merge`, { otherBookingId: currentLaterId });
            await refreshCurrentWindow();
          },
        });
      },
      async moveBooking(
        bookingId: number,
        to: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
        from: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
        guestName: string
      ) {
        if (!(await apiPatch(`/api/bookings/${bookingId}`, to))) return;
        await refreshCurrentWindow();
        pushHistory({
          label: `Move ${guestName}`,
          undo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, from);
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, to);
            await refreshCurrentWindow();
          },
        });
      },
      requestShareBedMove(params: {
        bookingId: number;
        guestName: string;
        otherBookingId: number;
        otherGuestName: string;
        otherArrivalDate: ISODate;
        otherDepartureDate: ISODate;
        to: { bedId: number; arrivalDate: ISODate; departureDate: ISODate };
        from: { bedId: number; arrivalDate: ISODate; departureDate: ISODate };
      }) {
        const { bookingId, guestName, otherBookingId, otherGuestName, otherArrivalDate, otherDepartureDate, to, from } = params;
        setConfirmModal({
          title: "Share this bed?",
          message: `There's already ${otherGuestName} sleeping here from ${formatDateUk(otherArrivalDate)} to ${formatDateUk(otherDepartureDate)}. Do you want ${guestName} and ${otherGuestName} to share the bed?`,
          confirmLabel: "Share the bed",
          onConfirm: async () => {
            const result = await apiPost<{ previousBookingShares: number | null; previousOtherShares: number | null }>(
              `/api/bookings/${bookingId}/pair-into-bed`,
              { otherBookingId, bedId: to.bedId, arrivalDate: to.arrivalDate, departureDate: to.departureDate }
            );
            if (!result) return;
            await refreshCurrentWindow();
            pushToast(`${guestName} now shares a bed with ${otherGuestName}.`);
            pushHistory({
              label: `Pair ${guestName} with ${otherGuestName}`,
              undo: async () => {
                await apiPatch(`/api/bookings/${bookingId}`, { ...from, sharesBedWithBookingId: result.previousBookingShares });
                await apiPatch(`/api/bookings/${otherBookingId}`, { sharesBedWithBookingId: result.previousOtherShares });
                await refreshCurrentWindow();
              },
              redo: async () => {
                await apiPost(`/api/bookings/${bookingId}/pair-into-bed`, {
                  otherBookingId,
                  bedId: to.bedId,
                  arrivalDate: to.arrivalDate,
                  departureDate: to.departureDate,
                });
                await refreshCurrentWindow();
              },
            });
          },
        });
      },
      async resizeBookingDates(
        bookingId: number,
        field: "arrivalDate" | "departureDate",
        fromValue: ISODate,
        toValue: ISODate,
        guestName: string
      ) {
        if (!(await apiPatch(`/api/bookings/${bookingId}`, { [field]: toValue }))) return;
        await refreshCurrentWindow();
        pushHistory({
          label: `Resize ${guestName}`,
          undo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, { [field]: fromValue });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPatch(`/api/bookings/${bookingId}`, { [field]: toValue });
            await refreshCurrentWindow();
          },
        });
      },
      async swapBookings(params: {
        draggedBookingId: number;
        otherBookingId: number;
        fromBedId: number;
        toBedId: number;
        draggedFrom: { arrivalDate: ISODate; departureDate: ISODate };
        draggedTo: { arrivalDate: ISODate; departureDate: ISODate };
        draggedName: string;
        otherName: string;
      }) {
        const { draggedBookingId, otherBookingId, fromBedId, toBedId, draggedFrom, draggedTo, draggedName, otherName } = params;
        // The dragged booking takes its (possibly date-shifted) new spot;
        // the displaced booking goes back to the origin bed with ITS OWN
        // dates untouched — that's the swap this pair is offered for in the
        // first place (see the reciprocity check in onPillPointerMove),
        // never a date change for the booking being evicted. One atomic
        // request (not two sequential PATCHes) — see /api/bookings/swap:
        // a naive two-call sequence can't be capacity-checked safely, since
        // at the instant the first call lands the other booking is still
        // sitting in the bed it's trading away.
        const ok = await apiPost("/api/bookings/swap", {
          draggedBookingId,
          otherBookingId,
          fromBedId,
          toBedId,
          draggedArrival: draggedTo.arrivalDate,
          draggedDeparture: draggedTo.departureDate,
        });
        if (!ok) return;
        await refreshCurrentWindow();
        pushToast(`Swapped ${draggedName} and ${otherName}`);
        pushHistory({
          label: `Swap ${draggedName} and ${otherName}`,
          undo: async () => {
            await apiPost("/api/bookings/swap", {
              draggedBookingId,
              otherBookingId,
              fromBedId: toBedId,
              toBedId: fromBedId,
              draggedArrival: draggedFrom.arrivalDate,
              draggedDeparture: draggedFrom.departureDate,
            });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bookings/swap", {
              draggedBookingId,
              otherBookingId,
              fromBedId,
              toBedId,
              draggedArrival: draggedTo.arrivalDate,
              draggedDeparture: draggedTo.departureDate,
            });
            await refreshCurrentWindow();
          },
        });
      },
      async moveEvent(
        eventId: number,
        name: string,
        notes: string | null,
        to: { startDate: ISODate; endDate: ISODate },
        from: { startDate: ISODate; endDate: ISODate }
      ) {
        const patch = { name, notes, startDate: to.startDate, endDate: to.endDate };
        if (!(await apiPatch(`/api/events/${eventId}`, patch))) return;
        await refreshCurrentWindow();
        pushHistory({
          label: `Move ${name}`,
          undo: async () => {
            await apiPatch(`/api/events/${eventId}`, { name, notes, startDate: from.startDate, endDate: from.endDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPatch(`/api/events/${eventId}`, patch);
            await refreshCurrentWindow();
          },
        });
      },
      async deleteEvent(eventId: number, name: string) {
        const snapshotRes = await fetch("/api/events");
        const snapshot = snapshotRes.ok ? (await snapshotRes.json()).find((e: { id: number }) => e.id === eventId) : null;
        if (!(await apiDelete(`/api/events/${eventId}`))) return;
        await refreshCurrentWindow();
        if (!snapshot) return;
        // Recreating on undo gets a NEW row id — this closure variable (not
        // the original eventId) is what redo/a later undo must target.
        let currentId = eventId;
        pushHistory({
          label: `Delete ${name}`,
          undo: async () => {
            const res = await apiPost<{ id: number }>("/api/events", {
              name: snapshot.name,
              startDate: snapshot.startDate,
              endDate: snapshot.endDate,
              notes: snapshot.notes,
            });
            if (res) currentId = res.id;
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiDelete(`/api/events/${currentId}`);
            await refreshCurrentWindow();
          },
        });
      },
      async moveBed(bedId: number, roomId: number, startDate: ISODate, previousRoomId: number, endDate?: ISODate | null) {
        const result = await apiPost("/api/bed-locations", { bedId, roomId, startDate, endDate: endDate ?? undefined });
        if (!result) return;
        await refreshCurrentWindow();
        if (previousRoomId === roomId) return; // dropped back where it started — nothing to undo
        pushHistory({
          label: "Move bed",
          undo: async () => {
            // Same effective date, previous room — POST's own truncate logic
            // (see /api/bed-locations) then puts the bed back exactly where
            // it was as of that date, the same way the forward move worked.
            // Deliberately open-ended even if the original move had its own
            // end date — undo just reverses "the bed changed room here", not
            // a perfect replay of whatever else happened to its room history
            // since.
            await apiPost("/api/bed-locations", { bedId, roomId: previousRoomId, startDate });
            await refreshCurrentWindow();
          },
          redo: async () => {
            await apiPost("/api/bed-locations", { bedId, roomId, startDate, endDate: endDate ?? undefined });
            await refreshCurrentWindow();
          },
        });
      },
      openBedActionModal: setBedActionModal,
      openJoinActionModal: (s: JoinActionModalState) => {
        setJoinError(null);
        setJoinActionModal(s);
      },
      openConfirmModal: setConfirmModal,
      navigate: (url: string) => router.push(url),
      dormStorageRoomId: data.dormStorageRoomId,
      today,
      panning,
      roomCellStyle,
      bedCellStyle,
      jumpToDate,
      splitGroups: data.splitGroups,
      mergeSplitBooking,
      showSharesWithText,
      showHoverDetails,
      pillNameMode,
      bedInfoById,
      jumpToSibling,
      viewportRef,
      stickyLabelWidth: labelColWidths.room + labelColWidths.bed,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.start, data.days, data.dormStorageRoomId, today, router, panning, roomCellStyle, bedCellStyle, data.splitGroups, showSharesWithText, showHoverDetails, pillNameMode, bedInfoById, labelColWidths.room, labelColWidths.bed]
  );

  // --- Visible-column geometry, shared by every row -------------------------

  const leadingWidth = virtualColumns[0]?.start ?? 0;
  const trailingWidth = virtualColumns.length > 0 ? virtualizer.getTotalSize() - virtualColumns[virtualColumns.length - 1].end : 0;

  const visibleColumns: VisibleColumn[] = virtualColumns.map((vc) => {
    const date = addDays(epochStart, vc.index);
    const dataIndex = vc.index - dataStartIndex;
    return { globalIndex: vc.index, date, dataIndex: dataIndex >= 0 && dataIndex < data.days ? dataIndex : null };
  });

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Grid</h1>
        {loading ? (
          <span className="tr-muted" style={{ fontSize: 12 }}>Loading…</span>
        ) : null}
        {(data.alerts.length + data.issueGroups.length) > 0 && (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setActionsMenuOpen((v) => !v)}
              data-tooltip="Allocation issues"
            >
              Alerts <span className="tr-actions-badge">{data.alerts.length + data.issueGroups.length}</span>
            </button>
            {actionsMenuOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setActionsMenuOpen(false)} />
                <div className="tr-actions-menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40 }}>
                  {data.alerts.length > 0 && (
                    <>
                      <div className="tr-actions-menu-title">
                        Needs a bed ({data.alerts.length})
                        <button
                          type="button"
                          className="primary"
                          disabled={autoAllocating}
                          onClick={() => runAutoAllocate()}
                          style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11, marginLeft: "auto" }}
                        >
                          {allocatingId === "bulk" ? "Allocating…" : "Auto-allocate next 7 days"}
                        </button>
                      </div>
                      <ul className="tr-actions-menu-list">
                        {data.alerts.map((a) => (
                          <li
                            key={a.id}
                            style={{ cursor: autoAllocating ? "default" : "pointer" }}
                            onClick={() => !autoAllocating && runAutoAllocate(a.id)}
                          >
                            <a href={`/bookings/${a.id}?from=grid`} onClick={(e) => e.stopPropagation()}>
                              {a.guestName}
                            </a>
                            <span className="tr-muted" style={{ fontSize: 11 }}>
                              {formatDateUk(a.arrivalDate)}–{formatDateUk(a.departureDate)}
                            </span>
                            <button
                              type="button"
                              className="tr-btn-soft"
                              disabled={autoAllocating}
                              onClick={(e) => {
                                e.stopPropagation();
                                runAutoAllocate(a.id);
                              }}
                              style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                            >
                              {allocatingId === a.id ? "…" : "Allocate"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {data.issueGroups.length > 0 && (
                    <>
                      <div className="tr-actions-menu-title">
                        Allocation issues ({data.issueGroups.length})
                        <button
                          type="button"
                          className="primary"
                          disabled={fixingAll}
                          onClick={runFixAll}
                          style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11, marginLeft: "auto" }}
                        >
                          {fixingAll ? "Fixing…" : "Fix all"}
                        </button>
                      </div>
                      <ul className="tr-actions-menu-list">
                        {data.issueGroups.map((g) => (
                          <li key={g.bookingId} style={{ display: "block" }}>
                            <div
                              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                              onClick={() => toggleGroupFix(g.bookingId)}
                            >
                              <div style={{ flex: 1 }}>{g.guestNames.join(", ")}</div>
                              <button
                                type="button"
                                className="tr-btn-soft"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleGroupFix(g.bookingId);
                                }}
                                style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                              >
                                {fixOpenGroupId === g.bookingId ? "Hide" : "Fix"}
                              </button>
                            </div>
                            {fixOpenGroupId === g.bookingId && (
                              <div style={{ marginTop: 4, marginBottom: 6 }}>
                                {fixLoading && <span className="tr-muted" style={{ fontSize: 11 }}>Looking for a room…</span>}
                                {fixError && <div style={{ fontSize: 11, marginBottom: 4 }}>{fixError}</div>}
                                {fixOptions && fixOptions.length === 0 && (
                                  <span className="tr-muted" style={{ fontSize: 11 }}>No room currently fits everyone — move manually.</span>
                                )}
                                {fixOptions && fixOptions.length > 0 && (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                                    {fixOptions.map((option) => {
                                      const names = [...new Set(option.moves.map((m) => m.guestName))];
                                      return (
                                        <div key={option.roomId}>
                                          {option.evictions.length > 0 && (
                                            <div className="tr-muted" style={{ fontSize: 10 }}>
                                              First {option.evictions
                                                .map((e) => (e.action === "split" ? `splits & moves part of ${e.guestName}'s stay` : `moves ${e.guestName}`))
                                                .join(", ")}{" "}
                                              to {option.evictions[0].newRoomName}.
                                            </div>
                                          )}
                                          <button
                                            type="button"
                                            className="tr-btn-soft"
                                            disabled={applyingFixRoomId === option.roomId}
                                            onClick={() => applyGroupFixOption(option)}
                                            style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                                          >
                                            {applyingFixRoomId === option.roomId ? "Moving…" : `Move ${names.join(", ")} to ${option.roomName}`}
                                          </button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
        {data.plannedChanges.length > 0 && (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setMovesMenuOpen((v) => !v)}
              data-tooltip="Bed moves, joins and splits for future dates"
            >
              Planned changes <span className="tr-actions-badge-neutral">{data.plannedChanges.length}</span>
            </button>
            {movesMenuOpen && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setMovesMenuOpen(false)} />
                <div className="tr-actions-menu" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 40 }}>
                  <div className="tr-actions-menu-title">
                    Planned changes ({data.plannedChanges.length})
                    <button
                      type="button"
                      className="tr-danger"
                      disabled={cancellingMoveId != null}
                      onClick={() => cancelPlannedChangeLines(data.plannedChanges, "all")}
                      style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11, marginLeft: "auto" }}
                    >
                      {cancellingMoveId === "all" ? "Cancelling…" : "Delete all planned changes"}
                    </button>
                  </div>
                  <ul className="tr-actions-menu-list">
                    {data.plannedChanges.map((m) => (
                      <li key={m.id}>
                        <div style={{ flex: 1 }}>{plannedChangeLineText(m)}</div>
                        <button
                          type="button"
                          className="tr-danger"
                          disabled={cancellingMoveId != null}
                          onClick={() => cancelPlannedChangeLines([m], m.id)}
                          style={{ minHeight: "unset", padding: "3px 8px", fontSize: 11 }}
                        >
                          {cancellingMoveId === m.id ? "…" : "Delete"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
        <GridSettingsMenu
          showSharesWithText={showSharesWithText}
          onShowSharesWithTextChange={updateShowSharesWithText}
          showHoverDetails={showHoverDetails}
          onShowHoverDetailsChange={updateShowHoverDetails}
          pillNameMode={pillNameMode}
          onPillNameModeChange={updatePillNameMode}
        />
        <span style={{ flex: 1 }} />
        <a href="/bookings/new?from=grid"><button type="button" className="primary">+ New booking</button></a>
        <button
          type="button"
          onClick={undo}
          disabled={historyPast.length === 0 || historyBusy}
          data-tooltip={historyPast.length > 0 ? `Undo: ${historyPast[historyPast.length - 1].label} (Ctrl+Z)` : "Nothing to undo"}
          aria-label="Undo"
        >
          ↶ Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={historyFuture.length === 0 || historyBusy}
          data-tooltip={historyFuture.length > 0 ? `Redo: ${historyFuture[historyFuture.length - 1].label} (Ctrl+Y)` : "Nothing to redo"}
          aria-label="Redo"
        >
          ↷ Redo
        </button>
        <button type="button" onClick={() => jumpToDate(today)}>Today</button>
        <div style={{ position: "relative" }}>
          <button
            type="button"
            aria-label="Jump to date"
            data-tooltip="Jump to date"
            onClick={() => setJumpPickerOpen((v) => !v)}
            style={{ height: 40, padding: "0 11px", display: "inline-flex", alignItems: "center" }}
          >
            <CalendarIcon />
          </button>
          {jumpPickerOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={() => setJumpPickerOpen(false)} />
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 40 }}>
                <CalendarPopover
                  value={isIsoDate(jumpValue) ? jumpValue : null}
                  onPick={(iso) => {
                    setJumpValue(iso);
                    setJumpPickerOpen(false);
                    jumpToDate(iso);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {error && <p className="tr-badge tr-badge-warn" style={{ marginBottom: 10 }}>{error}</p>}

      {data.grid.length === 0 && (
        <p className="tr-muted" style={{ marginBottom: 12 }}>
          No beds are placed in any room during this date range. Add floors, rooms and beds, then place beds in{" "}
          <a href="/settings/layout">Property Layout</a>.
        </p>
      )}

      <div
        ref={viewportRef}
        className={`tr-grid-viewport${panning ? " tr-grid-panning" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        <table className="tr-grid" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th className="tr-grid-room" style={roomCellStyle}>Room</th>
              <th className="tr-grid-bed" style={bedCellStyle}>Bed</th>
              {leadingWidth > 0 && <th style={{ width: leadingWidth, minWidth: leadingWidth }} />}
              {visibleColumns.map((col) => (
                <th
                  key={col.globalIndex}
                  className={[
                    isWeekend(col.date) && "tr-grid-weekend",
                    isPastDay(col.date, today) && "tr-grid-past",
                    col.date === today && "tr-grid-today",
                  ].filter(Boolean).join(" ") || undefined}
                  style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH }}
                >
                  <div>{weekday(col.date)}</div>
                  <div style={{ fontWeight: 400 }}>{formatDateUk(col.date).slice(0, 5)}</div>
                </th>
              ))}
              {trailingWidth > 0 && <th style={{ width: trailingWidth, minWidth: trailingWidth }} />}
            </tr>
          </thead>
          <tbody>
            {data.eventLanes.map((lane, laneIndex) => {
              // Pinned directly under the (already-sticky) header row, one
              // lane's height below the previous lane, so the whole event
              // strip stays visible no matter how far down the room rows
              // are scrolled — see .tr-grid-event-lane's own top offset math.
              const laneTop = HEADER_ROW_HEIGHT + laneIndex * GRID_ROW_HEIGHT;
              return (
                <tr key={`event-lane-${laneIndex}`} className="tr-grid-event-lane">
                  <td className="tr-grid-room tr-grid-event-head" style={{ ...roomCellStyle, top: laneTop }}>
                    {laneIndex === 0 ? "Events" : ""}
                  </td>
                  <td className="tr-grid-bed" style={{ ...bedCellStyle, top: laneTop }} />
                  {leadingWidth > 0 && <td style={{ width: leadingWidth, top: laneTop }} />}
                  {renderEventLaneCells(lane, visibleColumns, dataStartIndex, actions, laneTop)}
                  {trailingWidth > 0 && <td style={{ width: trailingWidth, top: laneTop }} />}
                </tr>
              );
            })}

            {data.grid.map((room, roomIndex) =>
              renderRoomRows(room, roomIndex, visibleColumns, leadingWidth, trailingWidth, actions)
            )}

            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={roomCellStyle}>Bed Occupancy</td>
              <td className="tr-grid-bed" style={bedCellStyle} />
              {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
              {visibleColumns.map((col) => {
                const occ = col.dataIndex != null ? data.occupiedByDate[col.dataIndex] : null;
                const tot = col.dataIndex != null ? data.totalByDate[col.dataIndex] : null;
                return (
                  <td key={col.globalIndex} className={occ != null && tot != null && occ > tot ? "tr-badge-warn" : undefined}>
                    {occ != null && tot != null ? `${occ}/${tot}` : ""}
                  </td>
                );
              })}
              {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
            </tr>
            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={roomCellStyle}>Arrivals</td>
              <td className="tr-grid-bed" style={bedCellStyle} />
              {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
              {visibleColumns.map((col) => (
                <td key={col.globalIndex}>{col.dataIndex != null ? data.arrByDate[col.dataIndex] || "" : ""}</td>
              ))}
              {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
            </tr>
            <tr className="tr-grid-summary">
              <td className="tr-grid-room" style={roomCellStyle}>Departures</td>
              <td className="tr-grid-bed" style={bedCellStyle} />
              {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
              {visibleColumns.map((col) => (
                <td key={col.globalIndex}>{col.dataIndex != null ? data.depByDate[col.dataIndex] || "" : ""}</td>
              ))}
              {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
            </tr>
          </tbody>
        </table>
      </div>

      {guestCategoriesForLegend.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 12 }}>
          <span className="tr-muted" style={{ fontSize: 12 }}>Guest type:</span>
          {guestCategoriesForLegend.map((c) => (
            <span
              key={c.id}
              className="tr-grid-booking-pill"
              style={{ position: "static", ...bookingColourVars(c.colour) }}
            >
              {c.name}
            </span>
          ))}
        </div>
      )}

      <HelpButton title="Using the grid">
        Drag anywhere on the grid to pan. Double-click a free cell to start a new booking, or a booking to edit it.
        Right-click a booking to edit or delete it. Drag a booking&apos;s middle to move it to a different bed, or its
        edge to change dates. Click or right-click a bed&apos;s name to move it, join it, or send it to Dorm Storage.
        Beds in Dorm Storage are greyed out and don&apos;t count toward capacity.
      </HelpButton>

      {moveProposals.length > 0 && (
        <div className="tr-grid-alerts-corner">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Room full — move group? ({moveProposals.length})</div>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
            {moveProposals.map((p) => (
              <li key={p.key} style={{ marginBottom: 10 }}>
                <div style={{ marginBottom: 4 }}>
                  Move <strong>{p.guestNames.join(", ")}</strong> from {p.fromRoomName} to <strong>{p.toRoomName}</strong>?
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={applyingProposalKey === p.key}
                    onClick={() => confirmMoveProposal(p)}
                    style={{ minHeight: "unset", padding: "3px 8px", fontSize: 12 }}
                  >
                    {applyingProposalKey === p.key ? "Moving…" : "Confirm"}
                  </button>
                  <button
                    type="button"
                    disabled={applyingProposalKey === p.key}
                    onClick={() => declineMoveProposal(p.key)}
                    style={{ minHeight: "unset", padding: "3px 8px", fontSize: 12 }}
                  >
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
      <BedActionModal
        state={bedActionModal}
        dormStorageRoomId={data.dormStorageRoomId}
        onClose={() => setBedActionModal(null)}
        onSubmit={async (bedId, roomId, startDate, previousRoomId, endDate) => {
          await actions.moveBed(bedId, roomId, startDate, previousRoomId, endDate);
          setBedActionModal(null);
        }}
      />
      <JoinActionModal
        state={joinActionModal}
        error={joinError}
        onClose={() => {
          setJoinActionModal(null);
          setJoinError(null);
        }}
        onSubmit={async (startDate, endDate, partnerBedId) => {
          if (!joinActionModal) return false;
          const ok = await actions.joinAsNew(joinActionModal.bed1Id, partnerBedId, joinActionModal.mode, startDate, endDate);
          if (ok) setJoinActionModal(null);
          return ok;
        }}
      />
      <JoinConflictModal
        state={joinConflictModal}
        onClose={() => setJoinConflictModal(null)}
        onResolve={async (resolution) => {
          if (!joinConflictModal) return;
          const ok = await joinConflictModal.retry(resolution);
          if (ok) setJoinConflictModal(null);
        }}
      />
      <ConfirmModal state={confirmModal} onClose={() => setConfirmModal(null)} />
      <SplitMergeConflictModal
        state={splitMergeConflict}
        onClose={() => setSplitMergeConflict(null)}
        onResolve={resolveSplitMergeConflict}
      />
      <PlannedChangeConflictModal
        state={plannedChangeConflict}
        onClose={() => setPlannedChangeConflict(null)}
        onResolve={resolvePlannedChangeConflict}
      />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}

// ---------------------------------------------------------------------------

// A bed parked in Dorm Storage is off active duty (see rooms.excludeFromCapacity)
// — every row for that room gets a fixed grey tint instead of the per-room
// palette cycle in roomColourStyle, plus .tr-grid-room-storage for dimmed
// text, so it reads as "greyed out" at a glance rather than just another
// room colour in the rotation. Deliberately background-COLOUR only, never
// `opacity`/`filter` on the <tr> — the Room/Bed label cells in this row are
// `position: sticky`, and opacity on an ancestor of a sticky element forces
// an isolated compositing layer that visibly seams/bleeds at the sticky
// element's edges as it scrolls (that's the "hatching bleeds over
// text/borders" bug), and would ALSO have flattened the weekend gradient
// and this tint into one layer before dimming instead of leaving them as
// independent, normally-composited background layers.
const DORM_STORAGE_ROOM_STYLE: React.CSSProperties = {
  ["--tr-room-tint" as string]: "#dbd7cd",
  ["--tr-room-label" as string]: "#c7c2b4",
} as React.CSSProperties;

function roomTrStyle(room: RoomGridRow, roomIndex: number): React.CSSProperties {
  return room.excludeFromCapacity ? DORM_STORAGE_ROOM_STYLE : roomColourStyle(roomIndex);
}

function roomTrClassName(isFirstRoomRow: boolean, room: RoomGridRow): string | undefined {
  const classes: string[] = [];
  if (isFirstRoomRow) classes.push("tr-grid-room-start");
  if (room.excludeFromCapacity) classes.push("tr-grid-room-storage");
  return classes.length > 0 ? classes.join(" ") : undefined;
}

/**
 * Clicking or right-clicking a bed's own label (the left sidebar, not a date
 * cell) opens: whatever join/switch/split options apply to that bed today
 * (if any — plain unjoinable beds get none), then always "Move bed" and
 * "Send to Dorm Storage". `joinMenu` is the same menu object already built
 * per date column in renderPairedBlock/renderNativePairBlock — see
 * `representativeMenu` there — so this never re-derives join state itself.
 */
function bedLabelMenu(
  bedId: number,
  bedLabel: string,
  room: RoomGridRow,
  actions: GridActions,
  joinMenu?: { title: string; items: ContextMenuItem[] }
): { title: string; items: ContextMenuItem[] } {
  const items: ContextMenuItem[] = [...(joinMenu?.items ?? [])];
  items.push({
    label: "Move bed",
    onClick: () => actions.openBedActionModal({ mode: "move", bedId, bedLabel, defaultDate: actions.today, previousRoomId: room.roomId }),
  });
  if (!room.excludeFromCapacity) {
    items.push({
      label: "Send to Dorm Storage",
      danger: true,
      onClick: () => actions.openBedActionModal({ mode: "storage", bedId, bedLabel, defaultDate: actions.today, previousRoomId: room.roomId }),
    });
  }
  return { title: joinMenu?.title ?? `${room.roomName} — ${bedLabel}`, items };
}

function bedLabelHandlers(
  bedId: number,
  bedLabel: string,
  room: RoomGridRow,
  actions: GridActions,
  joinMenu?: { title: string; items: ContextMenuItem[] }
) {
  const open = (e: React.MouseEvent) => {
    const menu = bedLabelMenu(bedId, bedLabel, room, actions, joinMenu);
    actions.openMenu(e, menu.title, menu.items);
  };
  return { onClick: open, onContextMenu: open };
}

type VisibleColumn = { globalIndex: number; date: ISODate; dataIndex: number | null };
type SlotCell = import("@/lib/grid").SlotCell;
type GridUnit = import("@/lib/grid").GridUnit;
type RoomGridRow = import("@/lib/grid").RoomGridRow;
type GridBooking = import("@/lib/grid").GridBooking;

interface GridActions {
  openMenu: (e: React.MouseEvent, title: string, items: ContextMenuItem[]) => void;
  joinAsNew: (
    bed1Id: number,
    bed2Id: number,
    mode: "double" | "solo",
    startDate: ISODate,
    endDate: ISODate | null,
    resolution?: "overwrite" | "trim"
  ) => Promise<boolean>;
  switchJoinMode: (bed1Id: number, bed2Id: number, atDate: ISODate, mode: "double" | "solo") => void;
  splitJoin: (bed1Id: number, bed2Id: number, atDate: ISODate) => void;
  goSolo: (bedId: number, atDate: ISODate) => void;
  goCouple: (bedId: number, atDate: ISODate) => void;
  cancelBooking: (bookingId: number, guestName: string) => void;
  splitBooking: (bookingId: number, splitDate: ISODate, guestName: string, originalDeparture: ISODate) => void;
  mergeBookings: (departingBookingId: number, arrivingBookingId: number, guestName: string) => void;
  moveBooking: (
    bookingId: number,
    to: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
    from: { bedId: number; arrivalDate: ISODate; departureDate: ISODate },
    guestName: string
  ) => void;
  requestShareBedMove: (params: {
    bookingId: number;
    guestName: string;
    otherBookingId: number;
    otherGuestName: string;
    otherArrivalDate: ISODate;
    otherDepartureDate: ISODate;
    to: { bedId: number; arrivalDate: ISODate; departureDate: ISODate };
    from: { bedId: number; arrivalDate: ISODate; departureDate: ISODate };
  }) => void;
  resizeBookingDates: (
    bookingId: number,
    field: "arrivalDate" | "departureDate",
    fromValue: ISODate,
    toValue: ISODate,
    guestName: string
  ) => void;
  swapBookings: (params: {
    draggedBookingId: number;
    otherBookingId: number;
    fromBedId: number;
    toBedId: number;
    draggedFrom: { arrivalDate: ISODate; departureDate: ISODate };
    draggedTo: { arrivalDate: ISODate; departureDate: ISODate };
    draggedName: string;
    otherName: string;
  }) => void;
  moveBed: (bedId: number, roomId: number, startDate: ISODate, previousRoomId: number, endDate?: ISODate | null) => void;
  moveEvent: (
    eventId: number,
    name: string,
    notes: string | null,
    to: { startDate: ISODate; endDate: ISODate },
    from: { startDate: ISODate; endDate: ISODate }
  ) => void;
  deleteEvent: (eventId: number, name: string) => void;
  openBedActionModal: (state: BedActionModalState) => void;
  openJoinActionModal: (state: JoinActionModalState) => void;
  openConfirmModal: (state: ConfirmModalState) => void;
  /** Client-side (no full reload) navigation — used for double-click-to-open on empty cells and bookings. */
  navigate: (url: string) => void;
  /** Target room id for "Send to Dorm Storage" — see ensureDormStorageRoomId in grid-data.ts. */
  dormStorageRoomId: number;
  /** Not a click handler — just data along for the ride, so the bed-label menu can default its date picker without threading a separate prop through every render*Block function. */
  today: ISODate;
  /** True for the duration of a drag-to-pan gesture — cell renderers use this to suppress their own `title` tooltip, which otherwise gets stuck showing (pointer capture during the pan stops the browser from ever re-hit-testing to dismiss it). */
  panning: boolean;
  /** Sticky-column inline styles for the Room/Bed label cells, sized to fit the longest room/floor name and bed label currently on screen — see the measurement effect near viewportRef. Passed along here (like dormStorageRoomId/today) so render*Block functions don't need it threaded through their own parameter lists. */
  roomCellStyle: React.CSSProperties;
  bedCellStyle: React.CSSProperties;
  /** Scrolls (and loads more data if needed) so `dateStr` is in view — used by the "Jump to" field and, per-booking, the split-sibling « / » nav icons on a pill. */
  jumpToDate: (dateStr: ISODate) => Promise<void>;
  /** Every split-booking lineage in the system, keyed by splitGroupId — see GridData.splitGroups. */
  splitGroups: Record<string, SplitSiblingBooking[]>;
  /** Merges every future part of a split booking onto the given part's own bed — see src/lib/split-merge.ts. Not currently on the undo/redo stack (see the module's own note). */
  mergeSplitBooking: (bookingId: number) => Promise<void>;
  /** Per-browser display preference (gear icon menu) — whether a pill spells out "(same bed as X)"/"(same room as X)" in full, or just shows the quiet satisfied/unsatisfied icon. */
  showSharesWithText: boolean;
  /** Per-browser display preference (gear icon menu) — whether hovering a booking pill shows the "GuestName - arrival to departure" detail tooltip. */
  showHoverDetails: boolean;
  /** Per-browser display preference (gear icon menu) — how much of a booking's name its pill shows. See pillDisplayName's own doc comment. */
  pillNameMode: PillNameMode;
  /** bedId -> its current room/type label, for the split-sibling nav chevrons' hover preview. */
  bedInfoById: Map<number, { bedLabel: string; roomName: string }>;
  /** Jumps to the other part of a split booking's date AND row, flashing it once it's in view — see the component's own jumpToSibling. */
  jumpToSibling: (bookingId: number, dateStr: ISODate) => Promise<void>;
  /** The scrollable grid viewport itself — used by renderBookingPill to work out whether a long booking's own name (pinned at the pill's left edge) has scrolled out of view behind the frozen Room/Bed columns; see pillNameIfHidden. */
  viewportRef: React.RefObject<HTMLDivElement | null>;
  /** Width of the frozen Room+Bed columns — the same value as roomCellStyle.width + bedCellStyle.width, passed separately since pillNameIfHidden needs a plain number, not two style objects. */
  stickyLabelWidth: number;
}

/**
 * Renders one room's rows. Three kinds of 2-row block get grouped together
 * so their rows can coordinate per date column:
 *   - an ACTUAL joined pair (`partnerUnitKey` points at the very next unit)
 *   - a NATIVE two-person bed (Queen/1.5/Double — one unit, 2 slots already)
 *   - two adjacent, still-independent Single beds — a "pairable" pair,
 *     eligible to be linked via right-click but not yet joined
 * Everything else renders as a plain single row per bed, as before.
 */
function renderRoomRows(
  room: RoomGridRow,
  roomIndex: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const roomRowCount = room.units.reduce((sum, unit) => sum + unit.slots.length, 0);
  let roomRowsRendered = 0;
  const rows: React.ReactNode[] = [];
  const units = room.units;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const next = units[i + 1];

    const isJoinedPair = unit.partnerUnitKey != null && next != null && next.key === unit.partnerUnitKey && unit.slots.length === 1 && next.slots.length === 1;
    if (isJoinedPair) {
      const isFirstRoomRow = roomRowsRendered === 0;
      const hasNextUnit = i + 2 < units.length;
      rows.push(...renderPairedBlock(room, roomIndex, unit, next, isFirstRoomRow, hasNextUnit, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      i += 1;
      continue;
    }

    const isNativePair = unit.slots.length === 2;
    if (isNativePair) {
      const isFirstRoomRow = roomRowsRendered === 0;
      const hasNextUnit = i + 1 < units.length;
      rows.push(...renderNativePairBlock(room, roomIndex, unit, isFirstRoomRow, hasNextUnit, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      continue;
    }

    const isSingle = unit.label.toLowerCase() === "single";
    const nextIsPairableSingle = !!next && next.partnerUnitKey == null && next.slots.length === 1 && next.label.toLowerCase() === "single";
    if (isSingle && unit.partnerUnitKey == null && nextIsPairableSingle && next) {
      const isFirstRoomRow = roomRowsRendered === 0;
      const hasNextUnit = i + 2 < units.length;
      rows.push(...renderPairableSinglesBlock(room, roomIndex, unit, next, isFirstRoomRow, hasNextUnit, roomRowCount, visibleColumns, leadingWidth, trailingWidth, actions));
      roomRowsRendered += 2;
      i += 1;
      continue;
    }

    for (let slotIndex = 0; slotIndex < unit.slots.length; slotIndex++) {
      const slot = unit.slots[slotIndex];
      const isFirstRoomRow = roomRowsRendered === 0;
      roomRowsRendered += 1;
      const isFirstUnitRow = slotIndex === 0;
      // Two beds only ever share a dashed (coupled) boundary when the data
      // model says so — a joined pair or a native 2-person bed, both handled
      // above. Every other adjacency inside a room (including between slots
      // of a >2-capacity unit, or between this unit and the next) is never a
      // coupling relationship, so it always gets the plain solid divider,
      // never left blank.
      const isLastSlotOfUnit = slotIndex === unit.slots.length - 1;
      const hasNextRowInRoom = !isLastSlotOfUnit || i + 1 < units.length;

      const specs: CellSpec[] = visibleColumns.map((col) => ({
        col,
        cell: col.dataIndex != null ? slot.cells[col.dataIndex] : null,
        // A row-coalesced unit (see grid.ts) spans more than one physical
        // bed over time — per-date actions (the "+" new-booking cell, Move
        // Bed) must target whichever bed is actually in service on THAT
        // date, not always the row's single representative bedId.
        bedId: (col.dataIndex != null ? unit.bedIdByDate?.[col.dataIndex] : null) ?? unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: hasNextRowInRoom ? "tr-grid-divider-solid" : "",
      }));

      rows.push(
        <tr key={`${unit.key}-${slotIndex}`} data-bed-id={unit.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
          {isFirstRoomRow && (
            <td className="tr-grid-room" style={actions.roomCellStyle} rowSpan={roomRowCount}>
              <div className="tr-grid-room-name" style={{ fontWeight: 600 }}>{room.roomName}</div>
              <div className="tr-muted tr-grid-room-meta" style={{ fontSize: 11 }}>{room.floorName}</div>
            </td>
          )}
          {isFirstUnitRow && (
            <td
              className="tr-grid-bed"
              style={{ ...actions.bedCellStyle, cursor: "pointer" }}
              rowSpan={unit.slots.length}
              {...bedLabelHandlers(unit.bedId, unit.label, room, actions)}
            >
              {unit.label}
            </td>
          )}
          {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
          {renderRowCells(specs, actions)}
          {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
        </tr>
      );
    }
  }

  return rows;
}

/**
 * An ACTUAL joined pair's two rows, decided per date column:
 *   - "solo" dates rowSpan unitA's cell down over unitB's, showing one
 *     merged "Solo Double" spot (unitB omits its own cell there — that's
 *     how HTML expects an irregular rowSpan to be built).
 *   - "double" dates render both cells independently with a dashed divider
 *     on unitA's bottom border.
 *   - dates with no active join at all (this window includes a stretch
 *     before/after the join) render as plain independent cells with a
 *     SOLID divider, and right-click offers starting a fresh join there —
 *     same as two never-joined singles.
 */
function renderPairedBlock(
  room: RoomGridRow,
  roomIndex: number,
  unitA: GridUnit,
  unitB: GridUnit,
  isFirstRoomRow: boolean,
  hasNextUnit: boolean,
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unitA.slots[0];
  const slotB = unitB.slots[0];
  const specsA: CellSpec[] = [];
  const specsB: CellSpec[] = [];
  // Same join/switch/split options already computed per date column below,
  // surfaced again on the bed LABEL's own context menu (see the "Join Beds"
  // item wired where this block's rows are built) — prefers whichever
  // column is actually today, since a label isn't tied to any one date.
  let representativeMenu: { title: string; items: ContextMenuItem[] } | undefined;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const mode = cellA?.joinBadge?.mode;
    const soloActive = mode === "solo" && !!cellB?.joinBadge && cellB.joinBadge.mode === "solo";
    const bothActive = cellA && cellA.state !== "inactive" && cellB && cellB.state !== "inactive";

    if (soloActive && cellA && cellB) {
      const primaryCell = cellA.joinBadge!.isPrimary ? cellA : cellB;
      const primaryBedId = cellA.joinBadge!.isPrimary ? unitA.bedId : unitB.bedId;
      const menu: ContextMenuState["items"] = [
        { label: "Switch to Couple Double", onClick: () => actions.switchJoinMode(unitA.bedId, unitB.bedId, col.date, "double") },
        { label: "Split into Singles", onClick: () => actions.splitJoin(unitA.bedId, unitB.bedId, col.date), danger: true },
      ];
      const soloMenu = { title: `${room.roomName} — Solo Double`, items: menu };
      if (col.date === actions.today || !representativeMenu) representativeMenu = soloMenu;
      const primaryLabel = cellA.joinBadge!.isPrimary ? unitA.label : unitB.label;
      specsA.push({
        col,
        cell: primaryCell,
        bedId: primaryBedId,
        bedLabel: primaryLabel,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        // Consumes both of this pair's own rows via rowSpan, so its bottom
        // edge borders the NEXT unit in the room, not a coupled bed —
        // never dashed here.
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        extraClass: "tr-grid-solo-merged",
        rowSpan: 2,
        menu: soloMenu,
      });
      // unitB renders nothing here — consumed by unitA's rowSpan.
    } else {
      // Forming a NEW join here is a physical bed-type change, so — same as
      // renderPairableSinglesBlock — it's only offered while BOTH beds are
      // actually free that date; the server rejects it outright otherwise
      // (see POST /api/joined-beds). Switching an EXISTING join's mode, or
      // splitting it back apart, is a different action with its own
      // (symmetric) server-side guard — those stay offered regardless of
      // booking state here, same as before.
      const canJoinHere = cellA?.state === "free" && cellB?.state === "free";
      const menu: ContextMenuItem[] = mode
        ? [
            { label: mode === "double" ? "Switch to Solo Double" : "Switch to Couple Double", onClick: () => actions.switchJoinMode(unitA.bedId, unitB.bedId, col.date, mode === "double" ? "solo" : "double") },
            { label: "Split into Singles", onClick: () => actions.splitJoin(unitA.bedId, unitB.bedId, col.date), danger: true },
          ]
        : canJoinHere
          ? [
              {
                label: "Join as Couple Double",
                onClick: () =>
                  actions.openJoinActionModal({
                    bed1Id: unitA.bedId,
                    bed2Id: unitB.bedId,
                    mode: "double",
                    title: `${room.roomName} — Join as Couple Double`,
                    defaultStartDate: col.date,
                    defaultEndDate: null,
                    // unitA/unitB already have a recorded join between exactly
                    // these two beds elsewhere in the window (that's why this
                    // renders via renderPairedBlock at all) — no partner
                    // ambiguity here, so just the one fixed option.
                    partnerOptions: [{ bedId: unitB.bedId, label: unitB.label, occupied: false }],
                  }),
              },
              {
                label: "Join as Solo Double",
                onClick: () =>
                  actions.openJoinActionModal({
                    bed1Id: unitA.bedId,
                    bed2Id: unitB.bedId,
                    mode: "solo",
                    title: `${room.roomName} — Join as Solo Double`,
                    defaultStartDate: col.date,
                    defaultEndDate: null,
                    partnerOptions: [{ bedId: unitB.bedId, label: unitB.label, occupied: false }],
                  }),
              },
            ]
          : [];
      const pairMenu = bothActive ? { title: `${room.roomName} — Single beds`, items: menu } : undefined;
      if (pairMenu && (col.date === actions.today || !representativeMenu)) representativeMenu = pairMenu;
      specsA.push({
        col,
        cell: cellA,
        bedId: unitA.bedId,
        bedLabel: unitA.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: mode === "double" ? "tr-grid-divider-dashed" : "tr-grid-divider-solid",
        menu: pairMenu,
      });
      specsB.push({
        col,
        cell: cellB,
        bedId: unitB.bedId,
        bedLabel: unitB.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        menu: pairMenu,
      });
    }
  }

  return [
    <tr key={`${unitA.key}-paired`} data-bed-id={unitA.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={actions.roomCellStyle} rowSpan={roomRowCount}>
          <div className="tr-grid-room-name" style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted tr-grid-room-meta" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td
        className="tr-grid-bed"
        style={{ ...actions.bedCellStyle, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitA.bedId, unitA.label, room, actions, representativeMenu)}
      >
        {unitA.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsA, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unitB.key}-paired`} data-bed-id={unitB.bedId} className={room.excludeFromCapacity ? "tr-grid-room-storage" : undefined} style={roomTrStyle(room, roomIndex)}>
      <td
        className="tr-grid-bed"
        style={{ ...actions.bedCellStyle, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitB.bedId, unitB.label, room, actions, representativeMenu)}
      >
        {unitB.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsB, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

/**
 * A native two-person bed's (Queen/1.5/Double) own 2 slots, decided per date
 * column: "solo" dates merge into one row (rowSpan), everything else (the
 * default) renders as 2 independent rows with a dashed divider — a Queen
 * always sleeps 2 unless explicitly switched to solo.
 */
function renderNativePairBlock(
  room: RoomGridRow,
  roomIndex: number,
  unit: GridUnit,
  isFirstRoomRow: boolean,
  hasNextUnit: boolean,
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unit.slots[0];
  const slotB = unit.slots[1];
  const specsA: CellSpec[] = [];
  const specsB: CellSpec[] = [];
  // See the same-named variable in renderPairedBlock — surfaced again on the
  // bed label's own context menu.
  let representativeMenu: { title: string; items: ContextMenuItem[] } | undefined;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const active = cellA && cellA.state !== "inactive";
    const soloActive = active && col.dataIndex != null && !!unit.soloByDate?.[col.dataIndex];

    if (soloActive && cellA) {
      const menu: ContextMenuItem[] = [
        { label: `Switch to Couple ${formatBedTypeLabel(unit.label)}`, onClick: () => actions.goCouple(unit.bedId, col.date), danger: true },
      ];
      const soloMenu = { title: `${room.roomName} — Solo ${formatBedTypeLabel(unit.label)}`, items: menu };
      if (col.date === actions.today || !representativeMenu) representativeMenu = soloMenu;
      specsA.push({
        col,
        cell: cellA,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        // Consumes both of this bed's own rows via rowSpan, so its bottom
        // edge borders the NEXT unit in the room — never dashed here.
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        extraClass: "tr-grid-solo-merged",
        rowSpan: 2,
        menu: soloMenu,
      });
    } else {
      const menu: ContextMenuItem[] | undefined = active
        ? [{ label: `Switch to Solo ${formatBedTypeLabel(unit.label)}`, onClick: () => actions.goSolo(unit.bedId, col.date) }]
        : undefined;
      const coupleMenu = menu ? { title: `${room.roomName} — ${formatBedTypeLabel(unit.label)}`, items: menu } : undefined;
      if (coupleMenu && (col.date === actions.today || !representativeMenu)) representativeMenu = coupleMenu;
      specsA.push({
        col,
        cell: cellA,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        // A native two-person bed's two rows are structurally coupled by
        // bed TYPE, not by a per-date join relationship — unlike the
        // Couple/Solo Double case, there's no "independent" state to fall
        // back to, so this stays dashed even on a date this unit isn't
        // placed anywhere (state "inactive"): it's still the same one bed,
        // the dashed seam is about its own shape, not its placement.
        dividerClass: "tr-grid-divider-dashed",
        menu: coupleMenu,
      });
      specsB.push({
        col,
        cell: cellB,
        bedId: unit.bedId,
        bedLabel: unit.label,
        roomName: room.roomName,
        excludeFromCapacity: room.excludeFromCapacity,
        roomId: room.roomId,
        dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
        menu: coupleMenu,
      });
    }
  }

  return [
    <tr key={`${unit.key}-native-a`} data-bed-id={unit.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={actions.roomCellStyle} rowSpan={roomRowCount}>
          <div className="tr-grid-room-name" style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted tr-grid-room-meta" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td
        className="tr-grid-bed"
        style={{ ...actions.bedCellStyle, cursor: "pointer" }}
        rowSpan={2}
        {...bedLabelHandlers(unit.bedId, unit.label, room, actions, representativeMenu)}
      >
        {unit.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsA, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unit.key}-native-b`} data-bed-id={unit.bedId} className={room.excludeFromCapacity ? "tr-grid-room-storage" : undefined} style={roomTrStyle(room, roomIndex)}>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsB, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

/**
 * Two adjacent Single beds that are NOT currently joined — always 2
 * independent rows with a solid divider (never merges: nothing to merge
 * until a join actually exists). Right-click on either row offers linking
 * them into a Couple or Solo Double starting that date.
 */
function renderPairableSinglesBlock(
  room: RoomGridRow,
  roomIndex: number,
  unitA: GridUnit,
  unitB: GridUnit,
  isFirstRoomRow: boolean,
  hasNextUnit: boolean,
  roomRowCount: number,
  visibleColumns: VisibleColumn[],
  leadingWidth: number,
  trailingWidth: number,
  actions: GridActions
) {
  const slotA = unitA.slots[0];
  const slotB = unitB.slots[0];
  const specsA: CellSpec[] = [];
  const specsB: CellSpec[] = [];
  // See the same-named variable in renderPairedBlock — surfaced again on the
  // bed label's own context menu.
  let representativeMenu: { title: string; items: ContextMenuItem[] } | undefined;

  for (const col of visibleColumns) {
    const cellA = col.dataIndex != null ? slotA.cells[col.dataIndex] : null;
    const cellB = col.dataIndex != null ? slotB.cells[col.dataIndex] : null;
    const bothActive = cellA && cellA.state !== "inactive" && cellB && cellB.state !== "inactive";
    // Joining is a physical bed-type change — pushing two mattresses
    // together — not a guest-pairing action (that's "Shares Bed With" on
    // the booking form instead), so BOTH beds involved must be free for
    // the server to actually accept it (see POST /api/joined-beds). Only
    // offering the action at all when the clicked bed (unitA) is itself
    // free avoids presenting a choice that's guaranteed to be rejected.
    const partnerOptions = singleUnitPartnerOptions(room, unitA.bedId, col.dataIndex);
    // unitA/unitB are just whichever two Singles happened to sort adjacent
    // (see sortRoomUnits) — NOT necessarily the two beds staff actually
    // mean to pair (e.g. a genuinely free bed elsewhere in the room, with
    // an occupied one sorting in between). Default to unitB only if it's
    // actually free for this date; otherwise search every other Single in
    // the room for one that is, so the default choice is never one the
    // server would reject outright. Still offered as a full list in the
    // modal either way, so staff can always override it.
    const cellBFree = cellB?.state === "free";
    const freeAlternative = partnerOptions.find((o) => o.bedId !== unitB.bedId && !o.occupied);
    const defaultBed2Id = cellBFree ? unitB.bedId : freeAlternative?.bedId ?? unitB.bedId;
    const canJoinHere = cellA?.state === "free";
    const menu: ContextMenuItem[] = canJoinHere
      ? [
          {
            label: "Join as Couple Double",
            onClick: () =>
              actions.openJoinActionModal({
                bed1Id: unitA.bedId,
                bed2Id: defaultBed2Id,
                mode: "double",
                title: `${room.roomName} — Join as Couple Double`,
                defaultStartDate: col.date,
                defaultEndDate: null,
                partnerOptions,
              }),
          },
          {
            label: "Join as Solo Double",
            onClick: () =>
              actions.openJoinActionModal({
                bed1Id: unitA.bedId,
                bed2Id: defaultBed2Id,
                mode: "solo",
                title: `${room.roomName} — Join as Solo Double`,
                defaultStartDate: col.date,
                defaultEndDate: null,
                partnerOptions,
              }),
          },
        ]
      : [];
    const sharedMenu = bothActive && menu.length > 0 ? { title: `${room.roomName} — Single beds`, items: menu } : undefined;
    if (sharedMenu && (col.date === actions.today || !representativeMenu)) representativeMenu = sharedMenu;

    specsA.push({
      col,
      cell: cellA,
      bedId: unitA.bedId,
      bedLabel: unitA.label,
      roomName: room.roomName,
      excludeFromCapacity: room.excludeFromCapacity,
      roomId: room.roomId,
      dividerClass: "tr-grid-divider-solid",
      menu: sharedMenu,
    });
    specsB.push({
      col,
      cell: cellB,
      bedId: unitB.bedId,
      bedLabel: unitB.label,
      roomName: room.roomName,
      excludeFromCapacity: room.excludeFromCapacity,
      roomId: room.roomId,
      dividerClass: hasNextUnit ? "tr-grid-divider-solid" : "",
      menu: sharedMenu,
    });
  }

  return [
    <tr key={`${unitA.key}-pairable`} data-bed-id={unitA.bedId} className={roomTrClassName(isFirstRoomRow, room)} style={roomTrStyle(room, roomIndex)}>
      {isFirstRoomRow && (
        <td className="tr-grid-room" style={actions.roomCellStyle} rowSpan={roomRowCount}>
          <div className="tr-grid-room-name" style={{ fontWeight: 600 }}>{room.roomName}</div>
          <div className="tr-muted tr-grid-room-meta" style={{ fontSize: 11 }}>{room.floorName}</div>
        </td>
      )}
      <td
        className="tr-grid-bed"
        style={{ ...actions.bedCellStyle, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitA.bedId, unitA.label, room, actions, representativeMenu)}
      >
        {unitA.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsA, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
    <tr key={`${unitB.key}-pairable`} data-bed-id={unitB.bedId} className={room.excludeFromCapacity ? "tr-grid-room-storage" : undefined} style={roomTrStyle(room, roomIndex)}>
      <td
        className="tr-grid-bed"
        style={{ ...actions.bedCellStyle, cursor: "pointer" }}
        rowSpan={1}
        {...bedLabelHandlers(unitB.bedId, unitB.label, room, actions, representativeMenu)}
      >
        {unitB.label}
      </td>
      {leadingWidth > 0 && <td style={{ width: leadingWidth }} />}
      {renderRowCells(specsB, actions)}
      {trailingWidth > 0 && <td style={{ width: trailingWidth }} />}
    </tr>,
  ];
}

interface CellSpec {
  col: VisibleColumn;
  cell: SlotCell | null;
  bedId: number;
  bedLabel: string;
  roomName: string;
  /** The bed's CURRENT room — captured into the Move Bed / Send to Dorm Storage modal payload so that action is undoable (see BedActionModalState.previousRoomId). */
  roomId: number;
  /** True only inside the system "Dorm Storage" room — see rooms.excludeFromCapacity. */
  excludeFromCapacity: boolean;
  /** Resolved border-bottom class — "" | "tr-grid-divider-solid" | "tr-grid-divider-dashed". Only ever set on the "top" row of a 2-row block. */
  dividerClass: string;
  extraClass?: string;
  /** Bed-specific join/switch/split options for this exact date, if any — merged with the universal Move Bed / Send to Dorm Storage items in cellMenuItems(). Ignored by bookingCellMenuItems (a booking's own menu is strictly Split/Merge/Delete). */
  menu?: { title: string; items: ContextMenuItem[] };
  /** 2 for a "Solo Double"/"Solo Queen" cell spanning both of a pair's rows; otherwise unset (1). */
  rowSpan?: number;
}

/**
 * A free (unbooked) date cell's right-click menu — merges whatever
 * bed-specific join/switch/split options apply on THIS exact date (from
 * spec.menu, if any) with the universal Move Bed / Send to Dorm Storage
 * actions, using the actual clicked cell's date (not just "today") as the
 * effective date. Never called for a cell that has a booking (or a
 * departing booking's tail) on it — see bookingCellMenuItems below, which
 * strictly offers only Split/Merge/Delete there instead.
 */
function cellMenuItems(spec: CellSpec, actions: GridActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [...(spec.menu?.items ?? [])];
  items.push({
    label: "Move bed",
    onClick: () => actions.openBedActionModal({ mode: "move", bedId: spec.bedId, bedLabel: spec.bedLabel, defaultDate: spec.col.date, previousRoomId: spec.roomId }),
  });
  if (!spec.excludeFromCapacity) {
    items.push({
      label: "Send to Dorm Storage",
      danger: true,
      onClick: () => actions.openBedActionModal({ mode: "storage", bedId: spec.bedId, bedLabel: spec.bedLabel, defaultDate: spec.col.date, previousRoomId: spec.roomId }),
    });
  }
  return items;
}

/**
 * Right-click menu for a cell that HAS a booking on it — either a booking's
 * own pill, or a plain "turnover" cell showing only a departing booking's
 * half-cell tail (see renderSingleCell). Strictly Split Booking / Merge
 * Bookings / Delete Booking, never the bed-layout actions cellMenuItems
 * offers — those are a structural change to the BED, and mixing them into
 * a booking's own menu invited moving/re-typing a bed out from under an
 * in-progress stay. Move Bed / Send to Dorm Storage / join options are
 * still reachable from the bed's own label column regardless.
 */
function bookingCellMenuItems(
  spec: CellSpec,
  actions: GridActions,
  booking: { id: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate; splitGroupId?: number | null },
  /** The exact date column that was right-clicked, if different from spec.col.date (a booking pill spans several columns — see renderBookingPill's onContextMenu). */
  clickDate?: ISODate
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { label: "Edit booking", onClick: () => actions.navigate(`/bookings/${booking.id}?from=grid`) },
  ];
  const splitDate = clickDate ?? spec.col.date;
  // Only offer a split strictly between the two edges — splitting exactly
  // on the arrival or departure date would leave a zero-night booking on
  // one side.
  if (splitDate > booking.arrivalDate && splitDate < booking.departureDate) {
    items.push({
      label: `Split booking on ${formatDateUk(splitDate)}`,
      onClick: () =>
        actions.openConfirmModal({
          title: "Split booking",
          message: `Split ${booking.guestName}'s booking into two separate bookings, dividing on ${formatDateUk(splitDate)}?`,
          confirmLabel: "Split",
          onConfirm: () => actions.splitBooking(booking.id, splitDate, booking.guestName, booking.departureDate),
        }),
    });
  }
  // `spec` is always the run's own first (arrival) cell, or (for a
  // turnover-only free cell) the departing booking passed as `booking`
  // itself — the only places SlotCell.departingBooking can be set (see
  // packBookingsIntoSlots in grid.ts). A matching guest name on a
  // back-to-back adjacent booking in the same bed is exactly the "checked
  // out and back in same day" case Merge Bookings reverses — but only
  // right-clicking the EXACT turnover day itself (this booking's own
  // arrival date, which is also the departing booking's departure date):
  // a multi-night pill's other days share this same `spec`/departingBooking
  // data (it's per-run, not per-column) and would otherwise offer Merge on
  // every night, not just the one day the two stays actually meet.
  const departingBooking = spec.cell?.departingBooking;
  if (
    departingBooking &&
    departingBooking.id !== booking.id &&
    splitDate === booking.arrivalDate &&
    departingBooking.guestName.trim().toLowerCase() === booking.guestName.trim().toLowerCase()
  ) {
    items.push({
      label: "Merge bookings",
      onClick: () =>
        actions.openConfirmModal({
          title: "Merge bookings",
          message: `Merge ${booking.guestName}'s two bookings (${formatDateUk(departingBooking.arrivalDate)}–${formatDateUk(departingBooking.departureDate)} and ${formatDateUk(booking.arrivalDate)}–${formatDateUk(booking.departureDate)}) into one continuous stay?`,
          confirmLabel: "Merge",
          onConfirm: () => actions.mergeBookings(departingBooking.id, booking.id, booking.guestName),
        }),
    });
  }
  if (booking.splitGroupId != null) {
    items.push({
      label: "Merge split parts onto this bed",
      onClick: () => actions.mergeSplitBooking(booking.id),
    });
  }
  items.push({
    label: "Delete booking",
    danger: true,
    onClick: () =>
      actions.openConfirmModal({
        title: "Delete booking",
        message: `Delete ${booking.guestName}'s booking (${formatDateUk(booking.arrivalDate)}–${formatDateUk(booking.departureDate)})? This can be undone with Ctrl+Z immediately after.`,
        confirmLabel: "Delete",
        onConfirm: () => actions.cancelBooking(booking.id, booking.guestName),
      }),
  });
  return items;
}

/**
 * Renders one row's (or, for a solo-merged pair, one shared) sequence of
 * date cells. A booking that spans several consecutive visible dates
 * collapses into a single colSpan'd pill rather than repeating the guest
 * name in every night's cell — mirrors how the event lane above merges
 * bands, just keyed off `cell.booking.id`. A run only merges while every
 * column shares the same divider treatment and rowSpan, so a mid-stay
 * change (e.g. a joined pair splitting) still breaks the pill at the right
 * date instead of painting through it. Crossing a weekend boundary does NOT
 * break the run — the pill stays one continuous element with the guest name
 * shown exactly once, and still gets accurate per-date weekend shading via
 * the tiled background gradient in renderBookingPill (see weekendOverlayVars).
 */
function renderRowCells(specs: CellSpec[], actions: GridActions): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < specs.length) {
    const spec = specs[i];
    if (spec.cell && spec.cell.state === "booked" && spec.cell.booking) {
      const bookingId = spec.cell.booking.id;
      let j = i + 1;
      while (
        j < specs.length &&
        specs[j].cell?.state === "booked" &&
        specs[j].cell?.booking?.id === bookingId &&
        specs[j].dividerClass === spec.dividerClass &&
        // spec.menu is never consulted for a BOOKED cell (bookingCellMenuItems,
        // not cellMenuItems, handles its context menu) — only free cells read
        // it. It varying per date here (e.g. a "Join as Couple Double" option
        // only appearing once a neighbouring bed exists) used to needlessly
        // split one continuous booking's pill into chevron'd fragments right
        // at that date, even though nothing about the booking itself changed.
        (specs[j].rowSpan ?? 1) === (spec.rowSpan ?? 1)
      ) {
        j += 1;
      }
      out.push(renderBookingPill(specs.slice(i, j), actions));
      i = j;
    } else {
      out.push(renderSingleCell(spec, actions));
      i += 1;
    }
  }
  return out;
}

/** One free/inactive/loading date cell — never part of a booking, so it always renders alone. */
/**
 * Half-width "tail" for a booking whose departureDate is exactly this cell's
 * date (see SlotCell.departingBooking) — checkout is exclusive, so this
 * date never belongs to that booking's own occupied-night run, but the
 * guest is still physically checking out THIS morning. Rendered flush
 * against the left edge so it sits back-to-back with whatever occupies the
 * right half (a same-day arrival's pill, inset to start at 50%, or the
 * ordinary "+" new-booking affordance narrowed to the right half).
 */
function renderDepartingTail(
  booking: GridBooking,
  actions: GridActions,
  arrivingBooking?: GridBooking,
  arrivingBedInfo?: { bedLabel: string; roomName: string }
) {
  const editHref = `/bookings/${booking.id}?from=grid`;
  // The later part of the SAME split-into-parts stay, picking up right here
  // (same bed, arriving the exact day this one departs) — see
  // laterSiblingIsAdjacentTail's own comment in renderBookingPill, which
  // suppresses that pill's own » in favour of showing it right here
  // instead, at the true right edge of this half/half turnover shape.
  const laterSibling =
    booking.splitGroupId != null && arrivingBooking?.splitGroupId === booking.splitGroupId ? arrivingBooking : undefined;
  return (
    <a
      key="departing-tail"
      href={editHref}
      data-booking-id={booking.id}
      draggable={false}
      // Shares .tr-grid-booking-pill's own background/border/text styling
      // (uniform colour throughout a booking's whole span, no separate
      // muted/grey identity for the tail) — .tr-grid-departing-tail only
      // overrides position/radius specifics.
      className="tr-grid-booking-pill tr-grid-departing-tail"
      // Bleeds -3px into the PREVIOUS cell's padding (the same trick
      // .tr-pill-continues-start/-end use) so this tail visually fuses with
      // that booking's own last-night pill — which now always renders
      // flush/bled on ITS right edge too (see renderBookingPill) — instead
      // of the two sitting in separate <td>s with a bare gap between them,
      // which read as a detached, floating box.
      style={{
        left: -3,
        width: COLUMN_WIDTH / 2 + 3,
        display: laterSibling ? "flex" : undefined,
        alignItems: "center",
        justifyContent: "flex-end",
        // Same override as the booking's own pill — see bookingColourVars.
        // This tail is a separate DOM element (a different <td>), so it
        // needs its own copy, not inherited.
        ...bookingColourVars(booking.guestCategoryColour),
      }}
      // See the identical comment on the "+" new-booking link in
      // renderSingleCell — without this, the viewport's own drag-to-pan
      // handler steals pointer capture and the click/dblclick below never
      // fires on this element at all.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.preventDefault()}
      onDoubleClick={(e) => {
        e.preventDefault();
        actions.navigate(editHref);
      }}
      // Symmetric with the main pill's own onMouseEnter/onMouseLeave (see
      // setOwnHoverHighlight) — hovering the tail should highlight the
      // WHOLE booking, not just this half, same as hovering the main pill
      // already does for the tail.
      onMouseEnter={() => setOwnHoverHighlight(booking.id)}
      onMouseLeave={() => clearOwnHoverHighlight(booking.id)}
    >
      {/* No name here — it's already shown once in the booking's own pill; this is just that same pill's visual tail. */}
      {laterSibling && (
        <span
          className="tr-grid-pill-split-nav"
          data-tooltip={`Later part — ${arrivingBedInfo ? `${arrivingBedInfo.bedLabel} in ${arrivingBedInfo.roomName}, ` : ""}from ${formatDateUk(laterSibling.arrivalDate)}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            clearSiblingHoverHighlight(laterSibling.id);
            actions.jumpToSibling(laterSibling.id, laterSibling.arrivalDate);
          }}
        >
          »
        </span>
      )}
    </a>
  );
}

function renderSingleCell(spec: CellSpec, actions: GridActions) {
  const { col, cell, bedId, roomName, dividerClass, extraClass, excludeFromCapacity, rowSpan } = spec;
  const classes = ["tr-grid-cell"];
  if (dividerClass) classes.push(dividerClass);
  if (extraClass) classes.push(extraClass);
  // Unlike a booking pill (see renderBookingPill/renderRowCells), a free or
  // inactive cell is NEVER colSpan'd across multiple dates — renderRowCells
  // only groups consecutive BOOKED cells into one wide <td>; every other
  // state goes through this function one date at a time. That makes past/
  // today shading here as simple as the header's own isPastDay check (no
  // gradient-offset math needed, unlike the weekend wallpaper below, which
  // DOES need to survive being tiled under an arbitrarily wide booking pill).
  if (isPastDay(col.date, actions.today)) classes.push("tr-grid-cell-past");
  else if (col.date === actions.today) classes.push("tr-grid-cell-today");
  const weekendStyle = weekendOverlayVars(col.date);

  // A "free" cell can still carry a departing booking's half-cell tail (see
  // SlotCell.departingBooking) — right-clicking it is right-clicking that
  // booking, so it gets the strict Split/Merge/Delete menu, not the
  // bed-layout one a genuinely empty cell offers.
  const onContextMenu = (e: React.MouseEvent) =>
    cell?.departingBooking
      ? actions.openMenu(e, cell.departingBooking.guestName, bookingCellMenuItems(spec, actions, cell.departingBooking, col.date))
      : actions.openMenu(e, spec.menu?.title ?? `${roomName} — ${spec.bedLabel}`, cellMenuItems(spec, actions));

  if (!cell || cell.state === "inactive") {
    return (
      <td
        key={col.globalIndex}
        data-bed-id={bedId}
        rowSpan={rowSpan}
        className={[...classes, "tr-grid-inactive"].join(" ")}
        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, ...weekendStyle }}
        data-tooltip={cell ? "Not placed in this room on this date" : "Loading…"}
      />
    );
  }

  // A bed parked in Dorm Storage is off active duty — no new bookings can
  // start on it, so the cell renders as a plain inert box: no "+" affordance,
  // no hover state, no click/double-click navigation. Right-click still
  // works (Move Bed, to bring it back into service).
  if (excludeFromCapacity) {
    return (
      <td
        key={col.globalIndex}
        data-bed-id={bedId}
        rowSpan={rowSpan}
        className={classes.join(" ")}
        style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, ...weekendStyle, cursor: "default" }}
        onContextMenu={onContextMenu}
        data-tooltip={`${roomName} — in Dorm Storage, not bookable`}
      />
    );
  }

  const newBookingHref = `/bookings/new?bedId=${bedId}&arrival=${col.date}&departure=${addDaysIso(col.date, 1)}&from=grid`;
  const departingBooking = cell.departingBooking;

  return (
    <td
      key={col.globalIndex}
      data-bed-id={bedId}
      rowSpan={rowSpan}
      className={classes.join(" ")}
      style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, ...weekendStyle }}
      onContextMenu={onContextMenu}
    >
      {departingBooking && renderDepartingTail(departingBooking, actions)}
      {/* No "+" at all on a past day — see .tr-grid-cell-past's own comment;
          a day that's visually "closed off" shouldn't still quietly accept
          a new booking underneath that greyed surface. departingBooking's
          tail (above) is unaffected — that's an existing booking's real
          checkout record, not a new-booking affordance. */}
      {!isPastDay(col.date, actions.today) && (
        <a
          className="tr-grid-new"
          draggable={false}
          href={newBookingHref}
          // CRITICAL: without this, the pointerdown bubbles to the grid
          // viewport's own onPointerDown (drag-to-pan), which calls its OWN
          // setPointerCapture on the SAME pointerId — capture is
          // last-caller-wins, so the viewport silently steals every
          // subsequent mouse/click/dblclick event, re-targeting them at the
          // viewport <div> instead of this <a> (same fix onPillPointerDown
          // already needed, and for the same reason — see its own comment).
          // Without this, double-clicking a free cell to start a new booking
          // silently does nothing at all.
          onPointerDown={(e) => e.stopPropagation()}
          // Single click is reserved for the grid's pan/click disambiguation
          // and (once dragging lands) selection — only a double-click starts a
          // new booking. The href is kept (rather than dropped) so opening in
          // a new tab / copying the link still works via the browser's own
          // context menu or a modifier-click. Navigation itself goes through
          // Next's client-side router (actions.navigate) rather than a full
          // page reload.
          onClick={(e) => e.preventDefault()}
          onDoubleClick={(e) => {
            e.preventDefault();
            actions.navigate(newBookingHref);
          }}
          // A departing guest's tail already claims the left half of this
          // column (same-day checkout) — narrow the "start a new booking"
          // affordance to the remaining right half so the two don't overlap.
          style={departingBooking ? { position: "absolute", left: COLUMN_WIDTH / 2, right: 0, top: 0, bottom: 0 } : undefined}
        >
          +
        </a>
      )}
    </td>
  );
}

// --- Booking pill drag: center-grab (move bed) vs edge-grab (resize dates) -
//
// Only one pill can be dragged at a time, and none of this needs a React
// re-render while it's happening (it's pure cursor/outline feedback plus a
// single committed change on release) — a module-level variable is simpler
// than threading a ref through renderBookingPill, which isn't a component
// and can't call useRef itself. Pointer capture (set on pointerdown) keeps
// delivering move/up events to the SAME element even once the cursor leaves
// the pill, so no window-level listeners are needed either.
type PillDragKind = "move" | "resize-start" | "resize-end";

type DropValidity = "valid" | "valid-shares" | "swap" | "invalid";

interface PillDragState {
  kind: PillDragKind;
  bookingId: number;
  guestName: string;
  /** A split booking's own dates never move by dragging — see onPillPointerDown's own comment. */
  isSplitBooking: boolean;
  /** Set whenever isSplitBooking — lets onPillPointerUp look up an adjacent sibling (actions.splitGroups) after a resize, to offer shifting its own start/end date to match. */
  splitGroupId: number | null;
  bedId: number;
  arrivalDate: ISODate;
  departureDate: ISODate;
  startX: number;
  startY: number;
  moved: boolean;
  hoverBedId: number | null;
  hoverRowEl: HTMLElement | null;
  pillEl: HTMLElement;
  /** The pill's own <td> rect at drag start — resize/move geometry is computed relative to this, never to the live (unchanged) DOM. */
  originRect: DOMRect | null;
  /** The floating preview (resize's dashed outline, or move's exact-size ghost) — created lazily on first move so a plain click never touches the DOM. */
  ghostEl: HTMLElement | null;
  /** Whole-day offset (both kinds): resize clamps this to a valid date range; move applies it unclamped to BOTH dates equally (a same-length shift, not a resize). What onPillPointerUp commits, so the commit always matches exactly what the ghost last showed. */
  lastDeltaDays: number;
  /** Move only: whether the currently-hovered bed+date target is a legal drop (free), a swap candidate (exactly one conflicting booking that can cleanly move back), or blocked — null while no target bed is resolved yet. */
  dropValidity: DropValidity | null;
  /** Move only: the booking(s) currently occupying the hovered target bed for the dragged booking's (possibly date-shifted) range. */
  conflicts: OccupancyEntry[];
  /** Latest raw pointer position — the auto-scroll loop below re-reads this every frame instead of only reacting to individual pointermove events, so scrolling keeps going even while the pointer sits still near an edge. */
  lastClientX: number;
  lastClientY: number;
  /** requestAnimationFrame handle for the edge auto-scroll loop, if running. */
  autoScrollRAF: number | null;
}

let pillDragState: PillDragState | null = null;

// How close to the scrollable viewport's own edge (in px) the pointer needs
// to get before auto-scroll kicks in, and how fast it scrolls right at the
// edge (tapering to 0 at EDGE_ZONE_PX away) — dragging a booking toward the
// bottom (or top/left/right) of the grid used to just stop working the
// moment the pointer left the currently-rendered rows/columns: with no
// scroll happening, the ghost's target row lookup (document.elementFromPoint
// at the pointer's position) found nothing there, fell back to the
// booking's own ORIGIN row, and the ghost visibly snapped back to wherever
// that happened to be on screen — which read as "the drag jumping to the
// top" whenever the origin bed was above the current scroll position.
const EDGE_ZONE_PX = 72;
const MAX_AUTO_SCROLL_PX = 30;

function autoScrollSpeed(distanceFromEdge: number): number {
  if (distanceFromEdge >= EDGE_ZONE_PX) return 0;
  if (distanceFromEdge <= 0) return MAX_AUTO_SCROLL_PX;
  return MAX_AUTO_SCROLL_PX * (1 - distanceFromEdge / EDGE_ZONE_PX);
}

/**
 * Scrolls `.tr-grid-viewport` toward wherever the pointer currently sits
 * near its edge, every animation frame, for as long as a drag is active —
 * both axes, since the grid virtualizes dates horizontally the same way it
 * lets rows overflow vertically, and a move can need either. Re-reads
 * pillDragState.lastClientX/Y each frame (kept fresh by onPillPointerMove)
 * rather than the position from whenever this loop started, so it responds
 * to the pointer immediately even between actual move events.
 */
function runAutoScrollLoop(viewport: HTMLElement) {
  const ds = pillDragState;
  if (!ds) return;
  const rect = viewport.getBoundingClientRect();
  // The Room/Bed columns are sticky (position: sticky) INSIDE this same
  // scrollable element, so they visually — and interactively — cover the
  // left EDGE_ZONE_PX of the viewport's own bounding rect at all times; a
  // pointer can never physically get closer to rect.left than the sticky
  // columns' own right edge. Measuring the left edge from there instead (not
  // raw rect.left) is what actually makes left-edge auto-scroll reachable.
  const roomEl = viewport.querySelector<HTMLElement>(".tr-grid-room");
  const bedEl = viewport.querySelector<HTMLElement>(".tr-grid-bed");
  const stickyWidth = (roomEl?.offsetWidth ?? 0) + (bedEl?.offsetWidth ?? 0);
  const upSpeed = autoScrollSpeed(ds.lastClientY - rect.top);
  const downSpeed = autoScrollSpeed(rect.bottom - ds.lastClientY);
  const leftSpeed = autoScrollSpeed(ds.lastClientX - (rect.left + stickyWidth));
  const rightSpeed = autoScrollSpeed(rect.right - ds.lastClientX);
  if (downSpeed > 0) viewport.scrollTop += downSpeed;
  else if (upSpeed > 0) viewport.scrollTop -= upSpeed;
  if (rightSpeed > 0) viewport.scrollLeft += rightSpeed;
  else if (leftSpeed > 0) viewport.scrollLeft -= leftSpeed;
  ds.autoScrollRAF = requestAnimationFrame(() => runAutoScrollLoop(viewport));
}

function ensureAutoScrollLoop(viewport: HTMLElement) {
  const ds = pillDragState;
  if (!ds || ds.autoScrollRAF != null) return;
  ds.autoScrollRAF = requestAnimationFrame(() => runAutoScrollLoop(viewport));
}

function stopAutoScrollLoop(ds: PillDragState | null) {
  if (ds?.autoScrollRAF != null) {
    cancelAnimationFrame(ds.autoScrollRAF);
    ds.autoScrollRAF = null;
  }
}

/**
 * Safety-net cleanup, callable with no event object in hand — used both by
 * the pill's own onPointerUp/onPointerCancel AND a window-level listener
 * (see useDragSafetyNet below) for the case pointer capture is somehow lost
 * without either of those firing on the pill itself (e.g. the OS steals
 * focus mid-drag). Without this, a failed/interrupted move leaves the
 * dimmed pill opacity and/or a ghost stuck until a full page refresh.
 */
function clearPillDragVisuals() {
  const ds = pillDragState;
  if (!ds) return;
  stopAutoScrollLoop(ds);
  ds.pillEl.style.opacity = "";
  ds.pillEl.style.cursor = "";
  ds.ghostEl?.remove();
  pillDragState = null;
}

/**
 * Left/right edge of the pill = resize that edge's date; everything between
 * = move (change bed). Fixed pixel width rather than a percentage split —
 * on a short (1-2 night) pill a 15%-of-width zone still leaves a move zone
 * only a handful of pixels wide, which reads as the resize cursor "sticking"
 * since almost any hover position near the pill's left/right lands inside
 * it. Capped to a third of the pill's own width so it never eats the whole
 * pill on something narrower than RESIZE_ZONE_PX * 2.
 */
// Small — resizing a date edge is a rare gesture next to center-grab
// (which handles both a bed-row change AND a date shift at once), so
// most of the pill should read as "move." Wide enough to actually hit
// with a mouse/trackpad (5px was below usable hover precision).
const RESIZE_ZONE_PX = 10;
function pillDragKindAtOffset(offsetX: number, width: number): PillDragKind {
  if (width <= 0) return "move";
  const zone = Math.min(RESIZE_ZONE_PX, width / 3);
  if (offsetX < zone) return "resize-start";
  if (offsetX > width - zone) return "resize-end";
  return "move";
}

/**
 * Clamps a raw (unsnapped-to-validity) day offset so the resulting date
 * range never collapses to zero/negative nights — the one thing that must
 * hold true throughout the drag, not just at commit, since the ghost is
 * only ever allowed to show a legal target.
 */
function clampResizeDeltaDays(ds: PillDragState, rawDeltaDays: number): number {
  const nights = nightsBetween(ds.arrivalDate, ds.departureDate);
  if (ds.kind === "resize-start") return Math.min(rawDeltaDays, nights - 1);
  if (ds.kind === "resize-end") return Math.max(rawDeltaDays, -(nights - 1));
  return rawDeltaDays;
}

function resizeGhostLabel(ds: PillDragState, deltaDays: number): string {
  if (ds.dropValidity === "invalid") return `Occupied by ${ds.conflicts[0]?.guestName ?? "another booking"} — can't extend`;
  return ds.kind === "resize-start"
    ? `Check-in ${formatDateUk(addDaysIso(ds.arrivalDate, deltaDays))}`
    : `Check-out ${formatDateUk(addDaysIso(ds.departureDate, deltaDays))}`;
}

function createResizeGhost(originRect: DOMRect): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "tr-pill-resize-ghost";
  // The real pill sits inset top:3px/bottom:3px within its row (see
  // .tr-grid-booking-pill), not filling the row's full height — match that
  // exactly rather than the row's own (taller) rect, or the ghost reads as
  // a visibly thicker/blockier box than the pill it's supposed to preview.
  ghost.style.top = `${originRect.top + 3}px`;
  ghost.style.height = `${originRect.height - 6}px`;
  const label = document.createElement("span");
  label.className = "tr-pill-resize-ghost-label";
  ghost.appendChild(label);
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Repositions the ghost from the ORIGINAL (drag-start) rect plus a whole
 * number of day-widths — never from the live pointer position directly —
 * so it can only ever land exactly on a column boundary, not partway
 * through one. This is the "snap to day boundaries" behaviour: the pixel
 * delta is converted to a day count once (Math.round in onPillPointerMove)
 * and every subsequent computation is in whole days from there.
 */
function updateResizeGhost(ds: PillDragState, deltaDays: number) {
  if (!ds.ghostEl || !ds.originRect) return;
  const offsetPx = deltaDays * COLUMN_WIDTH;
  // Width must match exactly (new nights) * COLUMN_WIDTH — the ghost's
  // whole job is to preview how long the booking will be. left is offset
  // by half a column from the <td>'s own edge to match where the real
  // pill's arrival half-cell inset actually starts (see leftInset in
  // renderBookingPill) — the committed pill+departure-tail pair's combined
  // visual span is exactly (nights * COLUMN_WIDTH) wide but shifted right
  // by half a column from the td boundaries, not flush with them. A
  // previous version instead shaved an extra COLUMN_WIDTH off the WIDTH to
  // approximate this, which underrepresented the booking's real length
  // (collapsing a 1-night resize's ghost toward zero) — half is only ever
  // applied to the position here, never subtracted from the length.
  const half = COLUMN_WIDTH / 2;
  if (ds.kind === "resize-start") {
    ds.ghostEl.style.left = `${ds.originRect.left + offsetPx + half}px`;
    ds.ghostEl.style.width = `${ds.originRect.width - offsetPx}px`;
  } else {
    ds.ghostEl.style.left = `${ds.originRect.left + half}px`;
    ds.ghostEl.style.width = `${ds.originRect.width + offsetPx}px`;
  }
  ds.ghostEl.classList.toggle("tr-pill-resize-ghost-invalid", ds.dropValidity === "invalid");
  const label = ds.ghostEl.querySelector<HTMLElement>(".tr-pill-resize-ghost-label");
  if (label) label.textContent = resizeGhostLabel(ds, deltaDays);
}

/**
 * Center-grab (full 2D move) preview: a fixed-position box matching the
 * dragged pill's exact width/height/shape (never the whole row) — created
 * once at drag-start size, then repositioned on BOTH axes as the pointer
 * moves: vertically to track whichever row it's over, horizontally by the
 * same snapped whole-day offset the resize ghost uses (see
 * clampResizeDeltaDays's sibling logic inline in onPillPointerMove — a
 * move never collapses/expands the stay, so there's nothing to clamp).
 * Colour reflects the live collision check rather than a blanket highlight.
 */
function createMoveGhost(ds: PillDragState): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "tr-pill-move-ghost";
  // Width must match the booking's real length exactly — ds.originRect.width
  // already IS (nights) * COLUMN_WIDTH. See the comment in updateResizeGhost
  // for why this used to subtract an extra COLUMN_WIDTH (a "half-cell
  // preview" idea that instead made every ghost, and a 1-night booking's
  // ghost especially, shorter than the booking actually is). Height/top are
  // set per-frame in updateMoveGhost instead of fixed here, since they
  // track whichever row is currently hovered (rows can differ in height —
  // a Solo Double's merged row is double-height).
  ghost.style.width = `${ds.originRect!.width}px`;
  const label = document.createElement("span");
  label.className = "tr-pill-move-ghost-label";
  label.textContent = ds.guestName;
  ghost.appendChild(label);
  document.body.appendChild(ghost);
  return ghost;
}

function moveGhostLabel(ds: PillDragState): string {
  if (ds.dropValidity === "swap") return `Swap with ${ds.conflicts[0]?.guestName ?? "guest"}`;
  if (ds.dropValidity === "valid-shares") return `Share bed with ${ds.conflicts[0]?.guestName ?? "guest"}?`;
  if (ds.dropValidity === "invalid") return "Occupied — can't drop here";
  const deltaDays = ds.lastDeltaDays;
  if (deltaDays === 0) return ds.guestName;
  return `${ds.guestName} — ${formatDateUk(addDaysIso(ds.arrivalDate, deltaDays))} to ${formatDateUk(addDaysIso(ds.departureDate, deltaDays))}`;
}

function updateMoveGhost(ds: PillDragState, rowRect: DOMRect) {
  if (!ds.ghostEl || !ds.originRect) return;
  // Match the real pill's own top:3px/bottom:3px inset (see
  // .tr-grid-booking-pill) within WHICHEVER row is currently hovered —
  // computed fresh each frame (not fixed at drag-start) so hovering a
  // taller row (a Solo Double's merged row) previews the pill at that
  // row's real height, not the origin row's.
  ds.ghostEl.style.top = `${rowRect.top + 3}px`;
  ds.ghostEl.style.height = `${rowRect.height - 6}px`;
  // Left is offset by half a column past the <td>'s own edge — see the
  // matching comment in updateResizeGhost for why (the arrival half-cell
  // inset the committed pill actually has).
  ds.ghostEl.style.left = `${ds.originRect.left + ds.lastDeltaDays * COLUMN_WIDTH + COLUMN_WIDTH / 2}px`;
  ds.ghostEl.classList.remove(
    "tr-pill-move-ghost-valid",
    "tr-pill-move-ghost-valid-shares",
    "tr-pill-move-ghost-swap",
    "tr-pill-move-ghost-invalid"
  );
  if (ds.dropValidity) ds.ghostEl.classList.add(`tr-pill-move-ghost-${ds.dropValidity}`);
  const label = ds.ghostEl.querySelector<HTMLElement>(".tr-pill-move-ghost-label");
  if (label) label.textContent = moveGhostLabel(ds);
}

function onPillPointerDown(
  e: React.PointerEvent<HTMLAnchorElement>,
  booking: { id: number; guestName: string; arrivalDate: ISODate; departureDate: ISODate; splitGroupId?: number | null },
  bedId: number
) {
  if (e.button !== 0) return;
  // CRITICAL: without this, the event keeps bubbling to the grid viewport's
  // own onPointerDown (drag-to-pan) handler, which calls its OWN
  // setPointerCapture on the SAME pointerId — capture is last-caller-wins,
  // so the viewport silently steals every pill drag and pans the grid
  // instead of moving/resizing the booking.
  e.stopPropagation();
  const rect = e.currentTarget.getBoundingClientRect();
  const kind = pillDragKindAtOffset(e.clientX - rect.left, rect.width);
  e.currentTarget.setPointerCapture(e.pointerId);
  const td = e.currentTarget.closest("td");
  pillDragState = {
    kind,
    bookingId: booking.id,
    guestName: booking.guestName,
    // A split booking's own date range must never be dragged — one part's
    // dates changing independently of its siblings would break the
    // "contiguous stay across beds" shape splitting/merging assumes. Only
    // its BED can move by dragging; use Split/Merge for the dates
    // themselves. See onPillPointerMove's move branch, which reads this.
    isSplitBooking: booking.splitGroupId != null,
    splitGroupId: booking.splitGroupId ?? null,
    bedId,
    arrivalDate: booking.arrivalDate,
    departureDate: booking.departureDate,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    hoverBedId: null,
    hoverRowEl: null,
    pillEl: e.currentTarget,
    // The <td> (not the <a>) rect — its width is an exact multiple of
    // COLUMN_WIDTH (colSpan * COLUMN_WIDTH), so day-offset math against it
    // lines up perfectly with column boundaries; the <a>'s own box has
    // padding/border insets that would throw that off by a few px.
    originRect: (td ?? e.currentTarget).getBoundingClientRect(),
    ghostEl: null,
    lastDeltaDays: 0,
    dropValidity: null,
    conflicts: [],
    lastClientX: e.clientX,
    lastClientY: e.clientY,
    autoScrollRAF: null,
  };
}

function onPillPointerMove(e: React.PointerEvent<HTMLAnchorElement>) {
  const ds = pillDragState;
  if (!ds) {
    // Not dragging yet — just show which zone a click would grab.
    const rect = e.currentTarget.getBoundingClientRect();
    const kind = pillDragKindAtOffset(e.clientX - rect.left, rect.width);
    e.currentTarget.style.cursor = kind === "move" ? "grab" : "ew-resize";
    return;
  }

  const dx = e.clientX - ds.startX;
  const dy = e.clientY - ds.startY;
  if (!ds.moved && Math.hypot(dx, dy) > 4) ds.moved = true;
  if (!ds.moved) return;

  // A real drag is underway — stop it from also being read as a native link
  // drag/URL-preview gesture or a text selection.
  e.preventDefault();
  e.stopPropagation();
  ds.pillEl.style.opacity = "0.6";

  ds.lastClientX = e.clientX;
  ds.lastClientY = e.clientY;
  const viewportEl = e.currentTarget.closest<HTMLElement>(".tr-grid-viewport");
  if (viewportEl) ensureAutoScrollLoop(viewportEl);

  if (ds.kind === "move") {
    // Center-grab: full 2D — horizontal movement shifts BOTH dates by the
    // same snapped day count (the stay's length never changes, so there's
    // nothing to clamp the way resize does), vertical movement (which row
    // the pointer is over) picks the target bed. The live pill is never
    // reparented/restyled mid-drag — an exact-size ghost (createMoveGhost)
    // tracks the proposed position instead, coloured by a live collision
    // check rather than a blanket row outline.
    if (!ds.ghostEl) ds.ghostEl = createMoveGhost(ds);
    // A split booking locks to vertical-only (bed change) — see
    // isSplitBooking's own doc comment on PillDragState.
    ds.lastDeltaDays = ds.isSplitBooking ? 0 : Math.round(dx / COLUMN_WIDTH);
    const proposedArrival = addDaysIso(ds.arrivalDate, ds.lastDeltaDays);
    const proposedDeparture = addDaysIso(ds.departureDate, ds.lastDeltaDays);

    const target = document.elementFromPoint(e.clientX, e.clientY);
    // Checked nearest-ancestor-first (not just the <tr>) — a row-coalesced
    // unit (see grid.ts) carries a per-cell data-bed-id for whichever
    // physical bed is in service on that exact date, which the <tr>'s own
    // data-bed-id (the row's single representative bed) can't express.
    const bedIdEl = target instanceof Element ? (target.closest("[data-bed-id]") as HTMLElement | null) : null;
    const rowEl = target instanceof Element ? (target.closest("tr[data-bed-id]") as HTMLElement | null) : null;
    // No row under the pointer (e.g. hovering the sticky room/bed label
    // columns) falls back to the booking's own bed, so a pure date-only
    // drag still resolves to a valid same-bed move.
    const targetBedId = bedIdEl?.dataset.bedId ? Number(bedIdEl.dataset.bedId) : ds.bedId;
    ds.hoverRowEl = rowEl;
    ds.hoverBedId = targetBedId;

    const targetConflicts = conflictingBookings(targetBedId, proposedArrival, proposedDeparture, ds.bookingId);
    // A capacity-2 bed (native Queen/1.5/Double) has room for one more
    // occupant even with an existing booking already in its other slot —
    // only a FULLY occupied bed (conflicts >= capacity) needs a swap or is
    // blocked outright. Checking conflict count alone (ignoring capacity)
    // used to treat "the bed's other slot is taken" as "the bed is full"
    // even on a 2-person bed with room to spare.
    const targetCapacity = bedCapacityIndex.get(targetBedId) ?? 1;
    if (targetConflicts.length < targetCapacity) {
      // Spare capacity on a bed that already has someone in it (a native
      // Queen/1.5/Double, or a joined-singles pair) is never a plain move —
      // only a deliberate "shares bed with" pairing may fill that second
      // slot, so this always routes through a confirmation, never silently.
      ds.dropValidity = targetConflicts.length > 0 ? "valid-shares" : "valid";
      ds.conflicts = targetConflicts;
    } else if (targetBedId !== ds.bedId && targetConflicts.length === 1 && targetCapacity === 1) {
      // Swap candidate — but only amber if evicting the one booking already
      // there back into the ORIGIN bed, keeping ITS OWN unchanged dates,
      // doesn't itself collide with anything ELSE already sitting in the
      // origin bed. Skipping this reciprocity check is exactly what used to
      // let a "successful" swap silently bounce the other booking into a
      // THIRD booking's dates — which grid.ts would then paper over by
      // spawning a phantom overflow row rather than actually resolving it.
      const other = targetConflicts[0];
      const reciprocalConflicts = conflictingBookings(ds.bedId, other.arrivalDate, other.departureDate, ds.bookingId);
      ds.dropValidity = reciprocalConflicts.length === 0 ? "swap" : "invalid";
      ds.conflicts = targetConflicts;
    } else {
      // Same-bed date move landing on an occupied date, or the target bed
      // is already at capacity with more than one booking in the way —
      // neither is resolvable by a simple swap.
      ds.dropValidity = "invalid";
      ds.conflicts = targetConflicts;
    }

    ds.pillEl.style.cursor = ds.dropValidity === "invalid" ? "not-allowed" : "grabbing";
    // The hovered <td> itself (not its <tr>) — a Solo Double's merged cell
    // is one <td rowSpan=2> sitting in the PRIMARY bed's row; that row's own
    // <tr> rect is only ever single-row tall (rowSpan bleeds the cell down
    // into the next <tr> without changing the row's own box), so sizing the
    // ghost off the <tr> left it half-height and pinned to the top instead
    // of centred across the full merged cell like the real pill is.
    const ghostCellEl = bedIdEl ?? rowEl ?? e.currentTarget.closest("tr");
    if (ghostCellEl) updateMoveGhost(ds, ghostCellEl.getBoundingClientRect());
    return;
  }

  // Edge-grab: locked to this row/bed, only horizontal movement (which date
  // column the pointer is over) matters. The live booking is never mutated
  // mid-drag — Math.round snaps the raw pixel delta to a whole column index
  // once, then a dashed ghost overlay (not the real pill) is redrawn from
  // that snapped day count. The actual date change only ever happens once,
  // in onPillPointerUp, from the last value computed here.
  if (!ds.ghostEl) ds.ghostEl = createResizeGhost(ds.originRect!);
  const rawDeltaDays = Math.round(dx / COLUMN_WIDTH);
  ds.lastDeltaDays = clampResizeDeltaDays(ds, rawDeltaDays);
  // Extending an edge can reach into a date this bed is already occupied
  // on (by a DIFFERENT booking) — unlike a move, there's no swap option
  // here (only one booking's dates are changing), so this is always just
  // valid/invalid, never a swap candidate. Blocking it here (ghost turns
  // red, commit refuses in onPillPointerUp) is what stops a resize from
  // ever silently pushing a bed over capacity — see checkBedCapacity on
  // the server for the same guard's authoritative backstop.
  const proposedArrival = ds.kind === "resize-start" ? addDaysIso(ds.arrivalDate, ds.lastDeltaDays) : ds.arrivalDate;
  const proposedDeparture = ds.kind === "resize-end" ? addDaysIso(ds.departureDate, ds.lastDeltaDays) : ds.departureDate;
  ds.conflicts = conflictingBookings(ds.bedId, proposedArrival, proposedDeparture, ds.bookingId);
  // A native multi-capacity bed (e.g. a 1.5-bed, capacity 2) legitimately
  // has room for ONE other overlapping occupant — comparing against the
  // bed's own capacity (not just "any conflict at all") is what
  // checkBedCapacity does server-side too; this used to always go invalid
  // the moment there was ANY other occupant, even a different guest in the
  // bed's other, genuinely free slot.
  const resizeBedCapacity = bedCapacityIndex.get(ds.bedId) ?? 1;
  ds.dropValidity = ds.conflicts.length < resizeBedCapacity ? "valid" : "invalid";
  updateResizeGhost(ds, ds.lastDeltaDays);
}

function onPillPointerUp(e: React.PointerEvent<HTMLAnchorElement>, actions: GridActions) {
  const ds = pillDragState;
  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  const deltaDays = ds?.lastDeltaDays ?? 0;
  clearPillDragVisuals();
  if (!ds || !ds.moved) return; // No real drag — a plain click/dblclick, handled by onClick/onDoubleClick.

  e.preventDefault();
  e.stopPropagation();

  if (ds.kind === "move") {
    const validKinds: DropValidity[] = ["valid", "valid-shares", "swap"];
    if (ds.hoverBedId == null || !ds.dropValidity || !validKinds.includes(ds.dropValidity)) return;
    const toArrival = addDaysIso(ds.arrivalDate, deltaDays);
    const toDeparture = addDaysIso(ds.departureDate, deltaDays);
    if (ds.hoverBedId === ds.bedId && deltaDays === 0) return; // dropped back where it started — no-op

    if (ds.dropValidity === "valid") {
      actions.moveBooking(
        ds.bookingId,
        { bedId: ds.hoverBedId, arrivalDate: toArrival, departureDate: toDeparture },
        { bedId: ds.bedId, arrivalDate: ds.arrivalDate, departureDate: ds.departureDate },
        ds.guestName
      );
    } else if (ds.dropValidity === "valid-shares") {
      const other = ds.conflicts[0];
      actions.requestShareBedMove({
        bookingId: ds.bookingId,
        guestName: ds.guestName,
        otherBookingId: other.id,
        otherGuestName: other.guestName,
        otherArrivalDate: other.arrivalDate,
        otherDepartureDate: other.departureDate,
        to: { bedId: ds.hoverBedId, arrivalDate: toArrival, departureDate: toDeparture },
        from: { bedId: ds.bedId, arrivalDate: ds.arrivalDate, departureDate: ds.departureDate },
      });
    } else {
      const other = ds.conflicts[0];
      actions.swapBookings({
        draggedBookingId: ds.bookingId,
        otherBookingId: other.id,
        fromBedId: ds.bedId,
        toBedId: ds.hoverBedId,
        draggedFrom: { arrivalDate: ds.arrivalDate, departureDate: ds.departureDate },
        draggedTo: { arrivalDate: toArrival, departureDate: toDeparture },
        draggedName: ds.guestName,
        otherName: other.guestName,
      });
    }
    return;
  }

  if (deltaDays === 0) return;
  // Extending into a date this bed is already occupied on — no action,
  // matching every other drag-based collision in this file (the move/swap
  // branch above, the join drop-target check). The server's
  // checkBedCapacity guard would reject this anyway; refusing it here
  // means the drag itself never commits an invalid change in the first
  // place.
  if (ds.dropValidity === "invalid") return;
  if (ds.kind === "resize-start") {
    const newArrival = addDaysIso(ds.arrivalDate, deltaDays);
    actions.resizeBookingDates(ds.bookingId, "arrivalDate", ds.arrivalDate, newArrival, ds.guestName);
    promptShiftAdjacentSplitSibling(ds, actions, "earlier", newArrival);
  } else {
    const newDeparture = addDaysIso(ds.departureDate, deltaDays);
    actions.resizeBookingDates(ds.bookingId, "departureDate", ds.departureDate, newDeparture, ds.guestName);
    promptShiftAdjacentSplitSibling(ds, actions, "later", newDeparture);
  }
}

/**
 * After resizing one part of a split booking, its neighbouring sibling (in a
 * DIFFERENT bed, picking up exactly where this part used to end/start) is
 * left behind at the old boundary — the two are no longer contiguous. Rather
 * than silently leaving that gap/overlap, or silently moving the sibling too
 * (its own bed/room choice is a separate decision Bert may not want touched),
 * this asks once, right after the resize itself has already committed.
 * Deliberately does nothing for isSplitBooking's OWN center-grab move (locked
 * to delta 0 already) — only a genuine edge resize can create this gap.
 */
function promptShiftAdjacentSplitSibling(
  ds: PillDragState,
  actions: GridActions,
  which: "earlier" | "later",
  newBoundaryDate: ISODate
) {
  if (ds.splitGroupId == null) return;
  const siblings = actions.splitGroups[String(ds.splitGroupId)] ?? [];
  const oldBoundaryDate = which === "earlier" ? ds.arrivalDate : ds.departureDate;
  const sibling =
    which === "earlier"
      ? siblings.find((s) => s.id !== ds.bookingId && s.departureDate === oldBoundaryDate)
      : siblings.find((s) => s.id !== ds.bookingId && s.arrivalDate === oldBoundaryDate);
  if (!sibling) return; // No adjacent part at that boundary — e.g. a gap already existed, or this is the lineage's first/last part.
  const siblingBedInfo = sibling.bedId != null ? actions.bedInfoById.get(sibling.bedId) : undefined;
  const siblingField = which === "earlier" ? "departureDate" : "arrivalDate";
  actions.openConfirmModal({
    title: "Split booking",
    message: `Change the next part of ${sibling.guestName}'s split booking${siblingBedInfo ? ` (${siblingBedInfo.bedLabel} in ${siblingBedInfo.roomName})` : ""} to ${
      which === "earlier" ? "end" : "start"
    } on ${formatDateUk(newBoundaryDate)} too?`,
    confirmLabel: which === "earlier" ? "Yes, shift end date" : "Yes, shift start date",
    cancelLabel: "No, I'll move manually",
    onConfirm: () => {
      actions.resizeBookingDates(sibling.id, siblingField, oldBoundaryDate, newBoundaryDate, sibling.guestName);
    },
  });
}

/**
 * Horizontal-only drag state for an event band: unlike a booking pill,
 * there's no bed/row dimension to change — dragging left/right just shifts
 * BOTH startDate and endDate by the same whole-day offset, the same way a
 * booking pill's center-grab move shifts a stay without changing its
 * length. Module-level for the same reason as pillDragState: the pointer
 * handlers are plain functions (not component closures), so drag state
 * can't live in React state without a re-render on every pixel of motion.
 */
interface EventDragState {
  eventId: number;
  name: string;
  notes: string | null;
  startDate: ISODate;
  endDate: ISODate;
  startX: number;
  moved: boolean;
  bandEl: HTMLElement;
  originRect: DOMRect | null;
  ghostEl: HTMLElement | null;
  lastDeltaDays: number;
}

let eventDragState: EventDragState | null = null;
// pointerup clears eventDragState before the browser's own follow-up
// "click" event fires on the same element, so that click can't check
// eventDragState.moved directly (it's already null) — this flag survives
// the gap so the click handler can still tell "was this the tail end of a
// real drag" and suppress the link navigation, same trick used for the
// grid viewport's own drag-to-pan vs click distinction (suppressClickRef).
let suppressNextEventClick = false;

function clearEventDragVisuals() {
  const ds = eventDragState;
  if (!ds) return;
  ds.bandEl.style.opacity = "";
  ds.bandEl.style.cursor = "";
  ds.ghostEl?.remove();
  eventDragState = null;
}

function onEventPointerDown(
  e: React.PointerEvent<HTMLAnchorElement>,
  event: { id: number; name: string; notes: string | null; startDate: ISODate; endDate: ISODate }
) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.currentTarget.setPointerCapture(e.pointerId);
  const td = e.currentTarget.closest("td");
  eventDragState = {
    eventId: event.id,
    name: event.name,
    notes: event.notes,
    startDate: event.startDate,
    endDate: event.endDate,
    startX: e.clientX,
    moved: false,
    bandEl: e.currentTarget,
    originRect: (td ?? e.currentTarget).getBoundingClientRect(),
    ghostEl: null,
    lastDeltaDays: 0,
  };
}

function onEventPointerMove(e: React.PointerEvent<HTMLAnchorElement>) {
  const ds = eventDragState;
  if (!ds) return;
  const dx = e.clientX - ds.startX;
  if (!ds.moved && Math.abs(dx) > 4) ds.moved = true;
  if (!ds.moved) return;

  e.preventDefault();
  e.stopPropagation();
  ds.bandEl.style.opacity = "0.6";
  ds.bandEl.style.cursor = "grabbing";

  if (!ds.ghostEl) ds.ghostEl = createResizeGhost(ds.originRect!);
  ds.lastDeltaDays = Math.round(dx / COLUMN_WIDTH);
  const offsetPx = ds.lastDeltaDays * COLUMN_WIDTH;
  ds.ghostEl.style.left = `${ds.originRect!.left + offsetPx}px`;
  ds.ghostEl.style.width = `${ds.originRect!.width}px`;
  const label = ds.ghostEl.querySelector<HTMLElement>(".tr-pill-resize-ghost-label");
  if (label) {
    label.textContent =
      ds.lastDeltaDays === 0
        ? ds.name
        : `${ds.name} — ${formatDateUk(addDaysIso(ds.startDate, ds.lastDeltaDays))} to ${formatDateUk(addDaysIso(ds.endDate, ds.lastDeltaDays))}`;
  }
}

function onEventPointerUp(e: React.PointerEvent<HTMLAnchorElement>, actions: GridActions) {
  const ds = eventDragState;
  if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  const deltaDays = ds?.lastDeltaDays ?? 0;
  suppressNextEventClick = ds?.moved ?? false;
  clearEventDragVisuals();
  if (!ds || !ds.moved || deltaDays === 0) return;

  e.preventDefault();
  e.stopPropagation();

  actions.moveEvent(
    ds.eventId,
    ds.name,
    ds.notes,
    { startDate: addDaysIso(ds.startDate, deltaDays), endDate: addDaysIso(ds.endDate, deltaDays) },
    { startDate: ds.startDate, endDate: ds.endDate }
  );
}

/**
 * Momentary attention-getter for a specific booking's pill(s) — used by the
 * split-sibling nav icons' click handler (jumpToSibling) so landing on the
 * other part after a jump is obvious even with several split bookings on
 * screen. Targets every element with this data-booking-id (normally just
 * one; harmless if a future window-scroll edge case ever renders a booking
 * as two fragments) rather than assuming a single match.
 */
/**
 * A booking's own "checks out today" departing tail (see renderDepartingTail)
 * is a SEPARATE <a> from its main pill, bled -3px into it so the two read as
 * one continuous shape — but a plain ring class applied to both boxes
 * independently draws two full rectangles, and where they overlap that
 * shows up as a stray extra vertical line right at the checkout-date seam.
 * Picks the right variant per matched element (full ring when a booking has
 * no tail on screen at all, a seam-omitting half-ring on each side when it
 * does) so the whole shape gets exactly one unbroken outline.
 */
function applyPillHighlightClasses(els: NodeListOf<HTMLElement>, add: boolean, baseClass: string) {
  const hasTail = Array.from(els).some((el) => el.classList.contains("tr-grid-departing-tail"));
  els.forEach((el) => {
    const variant = !hasTail ? baseClass : el.classList.contains("tr-grid-departing-tail") ? `${baseClass}-tail` : `${baseClass}-head`;
    el.classList.toggle(variant, add);
  });
}

function flashHighlightBooking(bookingId: number) {
  const els = document.querySelectorAll<HTMLElement>(`[data-booking-id="${bookingId}"]`);
  els.forEach((el) => {
    el.classList.remove("tr-grid-pill-flash", "tr-grid-pill-flash-head", "tr-grid-pill-flash-tail");
    // Force a reflow so re-adding the class restarts the CSS animation even
    // if this exact booking was just flashed a moment ago (rapid double
    // clicks) — without this, the class is already present and the second
    // add is a no-op, so the animation never restarts.
    void el.offsetWidth;
  });
  applyPillHighlightClasses(els, true, "tr-grid-pill-flash");
  window.setTimeout(() => applyPillHighlightClasses(els, false, "tr-grid-pill-flash"), 1500);
}

/** Held (not timed) highlight while hovering a split-sibling nav icon — see setSiblingHoverHighlight/clearSiblingHoverHighlight below the chevrons themselves. */
function setSiblingHoverHighlight(bookingId: number) {
  applyPillHighlightClasses(document.querySelectorAll<HTMLElement>(`[data-booking-id="${bookingId}"]`), true, "tr-grid-pill-hover-preview");
}
function clearSiblingHoverHighlight(bookingId: number) {
  applyPillHighlightClasses(document.querySelectorAll<HTMLElement>(`[data-booking-id="${bookingId}"]`), false, "tr-grid-pill-hover-preview");
}

/**
 * Extends a booking's own :hover styling (border/shadow — see
 * .tr-grid-pill-native-hover in globals.css) from whichever of its own
 * pieces the mouse actually lands on (main pill or departing tail) to the
 * OTHER piece too — plain CSS :hover only ever reaches the exact element
 * under the cursor, never a sibling in a different <td>, which is why the
 * highlight used to stop dead at the checkout-date seam. No head/tail seam
 * variant needed the way setSiblingHoverHighlight's accent ring needs one
 * (see applyPillHighlightClasses) — this is a plain border-colour/shadow
 * match, not a ring, so it fuses cleanly across the existing -3px bleed
 * overlap on its own. Reapplying the class to whichever element already
 * has real :hover is harmless — same computed style either way, not
 * additive.
 */
function setOwnHoverHighlight(bookingId: number) {
  document.querySelectorAll<HTMLElement>(`[data-booking-id="${bookingId}"]`).forEach((el) => el.classList.add("tr-grid-pill-native-hover"));
}
function clearOwnHoverHighlight(bookingId: number) {
  document.querySelectorAll<HTMLElement>(`[data-booking-id="${bookingId}"]`).forEach((el) => el.classList.remove("tr-grid-pill-native-hover"));
}

/**
 * A booking rendered once as a continuous rounded pill spanning every
 * consecutive visible date it covers, instead of repeating the guest name
 * (and arrival/departure marks as raw "<"/"/" characters) in every night's
 * cell. Rounded caps only appear on the true check-in/check-out edge — a
 * run cut off by the edge of the loaded/virtualized window gets a flat edge
 * and a small chevron instead, so it stays visually clear the stay
 * continues off-screen rather than actually ending there.
 */
function renderBookingPill(run: CellSpec[], actions: GridActions) {
  const first = run[0];
  const last = run[run.length - 1];
  const cell = first.cell!;
  const booking = cell.booking!;
  const lastCell = last.cell!;
  const startsHere = cell.isArrival === true;
  const endsHere = lastCell.isDeparture === true;

  // Needed already here (not just down where the icon itself renders,
  // below) — see tr-grid-booking-cell-split-tail just below.
  const siblingsForClasses = booking.splitGroupId != null ? actions.splitGroups[String(booking.splitGroupId)] ?? [] : [];
  const hasLaterSiblingChevron = endsHere && siblingsForClasses.some((s) => s.arrivalDate > booking.arrivalDate);

  const classes = ["tr-grid-cell", "tr-grid-booking-cell"];
  if (first.dividerClass) classes.push(first.dividerClass);
  if (first.extraClass) classes.push(first.extraClass);
  // This <td>'s own background is normally fully hidden behind the pill
  // (see .tr-grid-booking-pill's own "deliberately flat, no weekend
  // gradient" note — the pill itself never shows past/today shading, same
  // as it never shows weekend shading). It DOES peek through in one spot,
  // though: leftInset below leaves the LEFT HALF of the arrival day's own
  // column bare whenever there's no same-day departingBooking filling it —
  // without this, that sliver stayed whatever the room tint/weekend
  // pattern was, so today's pink (or a past day's hatch) silently never
  // appeared on any cell that happened to have a booking starting in it.
  // Only first.col.date (the run's own start date) can ever produce that
  // gap — every later date in a multi-night run is fully covered by the
  // pill itself, so there's nothing to key this off but the run's start.
  if (isPastDay(first.col.date, actions.today)) classes.push("tr-grid-cell-past");
  else if (first.col.date === actions.today) classes.push("tr-grid-cell-today");
  // A narrow (short-stay) pill's trailing » chevron is pinned to the
  // pill's true right edge (margin-left: auto — see the icon itself,
  // below), which can push it past this <td>'s own boundary into the
  // NEXT date's cell — same kind of overflow .tr-pill-continues-end's own
  // -3px bleed already handles, just further. That next cell (often a
  // same-day-turnover departing tail) shares this <td>'s own z-index: 2,
  // so at equal z-index the later cell wins the DOM-order tie and paints
  // over the chevron entirely — invisible, not just faint. Bumping THIS
  // cell to z-index: 3 only when it actually has a trailing chevron to
  // protect avoids raising it everywhere (which would just move the same
  // "later cell wins" problem one level up against whatever comes after).
  if (hasLaterSiblingChevron) classes.push("tr-grid-booking-cell-split-tail");

  const issues = booking.allocationIssues ?? [];
  const pillClasses = ["tr-grid-booking-pill"];
  if (!startsHere) pillClasses.push("tr-pill-continues-start");
  // The right edge of a booking's OWN run is never the true "ending cell"
  // any more (see leftInset/departingBooking below) — the departure date
  // itself is a separate <td> the run structurally can't include (its
  // state belongs to whatever's free/arriving there instead), so this edge
  // always bleeds flush into that next cell, same as a window-cutoff —
  // the half-cell rounded end cap lives on the departing tail in that next
  // cell instead (see renderDepartingTail), not here.
  pillClasses.push("tr-pill-continues-end");

  // Right-click a booking's own pill strictly offers Split/Merge/Delete
  // (see bookingCellMenuItems) — never the bed-layout actions a plain cell
  // gets, so a bed can't be moved/re-typed out from under an in-progress
  // stay without splitting it first.
  const onContextMenu = (e: React.MouseEvent) => {
    // A pill spans several date columns via one colSpan'd <td> — resolve
    // which exact column was clicked from pointer position (same
    // COLUMN_WIDTH-based day-offset math the drag ghosts use) so "Split
    // Booking on [Date]" offers the right date, not always the arrival date.
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.min(run.length - 1, Math.max(0, Math.floor((e.clientX - rect.left) / COLUMN_WIDTH)));
    const clickDate = run[idx].col.date;
    actions.openMenu(e, booking.guestName, bookingCellMenuItems(first, actions, booking, clickDate));
  };

  const width = COLUMN_WIDTH * run.length;
  const editHref = `/bookings/${booking.id}?from=grid`;
  // A true check-in occupies only the right half of its column — the left
  // half is that day's turnover for a DIFFERENT (departing) guest, so two
  // guests never visually overlap when they share a bed's calendar day.
  // Arrival day is always part of this run (it's the first occupied
  // night), so insetting it here is enough on its own. The mirror case
  // (checkout) has no equivalent inset on this side — the departure date
  // itself isn't part of this run at all (see the class comment above and
  // renderDepartingTail), so there's nothing to inset.
  const leftInset = startsHere ? COLUMN_WIDTH / 2 : 0;
  // Same-day turnover: this run's own first date is also a DIFFERENT
  // booking's departureDate (see SlotCell.departingBooking) — render that
  // outgoing guest's half-width tail in the left half of this same <td>,
  // flush against this pill's own left inset. Always rendered, even when
  // the "departing" booking is really this same split-into-parts stay's
  // own earlier part continuing here — that's still a real half/half day
  // split visually (same shape as any other arrival/departure day), it's
  // only the » jump-to-sibling chevron that needs special handling for
  // that case (see renderDepartingTail's own arrivingBooking param).
  const departingBooking = startsHere ? cell.departingBooking : undefined;

  // Split-sibling navigation: only at this run's TRUE edge (never a
  // window-scroll cutoff, which already owns that slot via the plain ‹/›
  // chevron below) — the closest earlier/later piece of the same original
  // split-into-parts stay, if this booking is one.
  const siblings = siblingsForClasses;
  const earlierSibling = startsHere
    ? [...siblings].filter((s) => s.arrivalDate < booking.arrivalDate).sort((a, b) => b.arrivalDate.localeCompare(a.arrivalDate))[0]
    : undefined;
  const laterSibling = endsHere
    ? [...siblings].filter((s) => s.arrivalDate > booking.arrivalDate).sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate))[0]
    : undefined;
  const earlierSiblingBedInfo = earlierSibling?.bedId != null ? actions.bedInfoById.get(earlierSibling.bedId) : undefined;
  const laterSiblingBedInfo = laterSibling?.bedId != null ? actions.bedInfoById.get(laterSibling.bedId) : undefined;
  // When the later sibling picks up immediately (same bed, arriving the
  // exact day this one departs), it renders right next door via this same
  // booking's own departing tail (see renderDepartingTail's arrivingBooking
  // param) — the » chevron belongs THERE instead, at the true right edge of
  // the half/half turnover shape, not stranded inside this pill's own
  // (visually shorter) box. Any other case — different bed, or a gap in
  // dates — has no tail standing in for it, so the chevron stays here.
  const laterSiblingIsAdjacentTail =
    laterSibling != null && laterSibling.bedId === booking.bedId && laterSibling.arrivalDate === booking.departureDate;

  return (
    <td
      key={first.col.globalIndex}
      data-bed-id={first.bedId}
      colSpan={run.length}
      rowSpan={first.rowSpan}
      className={classes.join(" ")}
      style={{ width, minWidth: width, maxWidth: width, ...weekendOverlayVars(first.col.date) }}
      onContextMenu={onContextMenu}
      // No guest name here — it's already right there on the pill itself
      // (see .tr-grid-pill-name); repeating it in the tooltip was pure
      // noise. Issues stay out of this one too — the ⚠ icon carries its
      // own dedicated tooltip with that text already.
      data-tooltip={
        actions.showHoverDetails ? `${formatDateUk(booking.arrivalDate)} to ${formatDateUk(booking.departureDate)}` : undefined
      }
    >
      {departingBooking && renderDepartingTail(departingBooking, actions, booking, actions.bedInfoById.get(booking.bedId))}
      <a
        href={editHref}
        data-booking-id={booking.id}
        draggable={false}
        className={pillClasses.join(" ")}
        // Right edge is always handled by the (now unconditional)
        // tr-pill-continues-end class's `!important` rule, not inline —
        // see the pillClasses comment above. See bookingColourVars for why
        // both --tr-booking-color and --tr-booking-fill get set here.
        style={{ left: leftInset, ...bookingColourVars(booking.guestCategoryColour) }}
        // Single click is reserved for drag disambiguation — only a
        // double-click (no real drag happened) opens the edit page. A drag
        // that actually moved the pointer is consumed entirely by
        // onPillPointerUp (preventDefault + stopPropagation there), so it
        // never reaches onClick/onDoubleClick at all. Navigation itself goes
        // through Next's client-side router (actions.navigate), not a full
        // page reload.
        onClick={(e) => e.preventDefault()}
        onDoubleClick={(e) => {
          e.preventDefault();
          actions.navigate(editHref);
        }}
        onPointerDown={(e) => onPillPointerDown(e, booking, first.bedId)}
        onPointerMove={onPillPointerMove}
        onPointerUp={(e) => onPillPointerUp(e, actions)}
        onPointerCancel={(e) => onPillPointerUp(e, actions)}
        onPointerLeave={(e) => {
          if (!pillDragState) e.currentTarget.style.cursor = "";
        }}
        // Hovering ANY part of a split booking previews every OTHER part —
        // not just the tiny « / » chevron hotspot, which was easy to miss
        // as the actual trigger. siblings is only ever non-empty for a
        // split booking, so this is a no-op for a plain one.
        // Only the OTHER parts — highlighting this pill too (siblings
        // includes itself) put a second box-shadow ring on the very pill
        // being hovered, which visibly clashed with its own border and, for
        // two same-day-turnover parts sitting flush against each other,
        // pinched into a figure-eight where the two rings met.
        onMouseEnter={(e) => {
          siblings.filter((s) => s.id !== booking.id).forEach((s) => setSiblingHoverHighlight(s.id));
          setOwnHoverHighlight(booking.id);
          const nameTooltip = pillNameIfHidden(e.currentTarget, actions, booking.guestName);
          if (nameTooltip) e.currentTarget.setAttribute("data-tooltip", nameTooltip);
        }}
        // Recomputed on every move, not just on enter: a wheel/trackpad
        // scroll while the cursor sits still over the same pill doesn't
        // re-fire mouseenter (the pointer never actually leaves the
        // element), so a name that scrolls into or out of view mid-hover
        // needs this to catch up. TooltipHost's own global "hide on any
        // scroll" listener already dismisses whatever's showing the instant
        // a scroll happens, so this only ever affects the NEXT hover frame.
        onMouseMove={(e) => {
          const nameTooltip = pillNameIfHidden(e.currentTarget, actions, booking.guestName);
          if (nameTooltip) e.currentTarget.setAttribute("data-tooltip", nameTooltip);
          else e.currentTarget.removeAttribute("data-tooltip");
        }}
        onMouseLeave={(e) => {
          siblings.filter((s) => s.id !== booking.id).forEach((s) => clearSiblingHoverHighlight(s.id));
          clearOwnHoverHighlight(booking.id);
          e.currentTarget.removeAttribute("data-tooltip");
        }}
      >
        {!startsHere && (
          <span className="tr-grid-pill-chevron" aria-hidden="true">‹</span>
        )}
        {earlierSibling && (
          <span
            className="tr-grid-pill-split-nav"
            data-tooltip={`Earlier part — ${
              earlierSiblingBedInfo ? `${earlierSiblingBedInfo.bedLabel} in ${earlierSiblingBedInfo.roomName}, ` : ""
            }from ${formatDateUk(earlierSibling.arrivalDate)}`}
            // No onMouseEnter/onMouseLeave of its own — this chevron sits
            // INSIDE the pill's own <a> (a mouseenter/mouseleave pair
            // doesn't fire again on internal moves between parent and
            // child), so the parent's whole-pill hover below already covers
            // it. A separate pair here used to clear the highlight the
            // moment the pointer left the chevron for the rest of the same
            // pill — even though the parent was still being hovered — which
            // read as "the highlight only works right on the arrow."
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearSiblingHoverHighlight(earlierSibling.id);
              actions.jumpToSibling(earlierSibling.id, earlierSibling.arrivalDate);
            }}
          >
            «
          </span>
        )}
        {issues.length > 0 ? (
          <span className="tr-grid-pill-alert" aria-hidden="true" data-tooltip={`Should ${issues.map((i) => (i.kind === "bed" ? `share a bed with ${i.otherGuestName}` : `be in the same room as ${i.otherGuestName}`)).join("; ")}`}>
            ⚠
          </span>
        ) : (
          booking.relationship && (
            // A quiet, always-on signal that a "Sleeps near"/"Shares bed
            // with" relationship IS being met — the mirror of the ⚠ alert
            // above for when it's NOT. Kept separate from the full "(same
            // bed as X)" text (see tr-grid-pill-relation below), which is
            // the one part staff can turn off — see the grid's own gear menu.
            <span
              className="tr-grid-pill-satisfied"
              aria-hidden="true"
              data-tooltip={`${booking.relationship.kind === "bed" ? "Shares a bed with" : "Same room as"} ${booking.relationship.otherGuestName}`}
            >
              👥
            </span>
          )
        )}
        {booking.notes && (
          // Placed right before the name, like the ⚠/👥 icons above — NOT
          // the note text itself (that would compete with the guest name
          // for the pill's limited width). Hover/tap for the full text via
          // the shared tooltip system, which has no clipping problem here
          // even though the pill's own <td> is overflow: hidden.
          <span className="tr-grid-pill-note-icon" aria-hidden="true" data-tooltip={booking.notes}>
            📝
          </span>
        )}
        <span className="tr-grid-pill-name">{pillDisplayName(booking, actions.pillNameMode)}</span>
        {booking.relationship && actions.showSharesWithText && (
          <span className="tr-grid-pill-relation">
            ({booking.relationship.kind === "bed" ? "same bed as" : "same room as"} <strong>{booking.relationship.otherGuestName}</strong>)
          </span>
        )}
        {laterSibling && !laterSiblingIsAdjacentTail && (
          <span
            // margin-left: auto pins this flush against the pill's true
            // right edge (previously it just sat wherever it fell in flow,
            // right after the name/relation text) — the « on the other end
            // is already flush left by simply being the first flex child,
            // no equivalent push needed there.
            className="tr-grid-pill-split-nav"
            style={{ marginLeft: "auto" }}
            data-tooltip={`Later part — ${
              laterSiblingBedInfo ? `${laterSiblingBedInfo.bedLabel} in ${laterSiblingBedInfo.roomName}, ` : ""
            }from ${formatDateUk(laterSibling.arrivalDate)}`}
            // See the earlier-part chevron's own comment above — no
            // onMouseEnter/onMouseLeave here either, same reason.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearSiblingHoverHighlight(laterSibling.id);
              actions.jumpToSibling(laterSibling.id, laterSibling.arrivalDate);
            }}
          >
            »
          </span>
        )}
        {!endsHere && (
          <span className="tr-grid-pill-chevron" aria-hidden="true">›</span>
        )}
      </a>
    </td>
  );
}

function renderEventLaneCells(
  lane: GridData["eventLanes"][number],
  visibleColumns: VisibleColumn[],
  dataStartIndex: number,
  actions: GridActions,
  laneTop: number
) {
  const cells: React.ReactNode[] = [];
  let i = 0;
  while (i < visibleColumns.length) {
    const col = visibleColumns[i];
    const band = lane.find((b) => {
      const globalStart = dataStartIndex + b.startIndex;
      const globalEnd = globalStart + b.span;
      return col.globalIndex >= globalStart && col.globalIndex < globalEnd;
    });

    if (!band) {
      cells.push(<td key={col.globalIndex} style={{ width: COLUMN_WIDTH, minWidth: COLUMN_WIDTH, maxWidth: COLUMN_WIDTH, top: laneTop }} />);
      i += 1;
      continue;
    }

    const globalStart = dataStartIndex + band.startIndex;
    const globalEnd = globalStart + band.span;
    let span = 0;
    while (i < visibleColumns.length && visibleColumns[i].globalIndex >= globalStart && visibleColumns[i].globalIndex < globalEnd) {
      span += 1;
      i += 1;
    }

    cells.push(
      <td
        key={`band-${band.event.id}-${col.globalIndex}`}
        colSpan={span}
        className={[
          "tr-grid-event",
          band.continuesBefore ? "tr-grid-event-open-start" : "",
          band.continuesAfter ? "tr-grid-event-open-end" : "",
        ].filter(Boolean).join(" ")}
        style={{ ...eventColourStyle(band.event.id, band.event.colour), top: laneTop }}
        data-tooltip={`${band.event.name} - ${formatDateUk(band.event.startDate)} to ${formatDateUk(band.event.endDate)}${band.event.notes ? `\n${band.event.notes}` : ""}`}
        onContextMenu={(e) => {
          actions.openMenu(e, band.event.name, [
            {
              label: "Delete",
              danger: true,
              onClick: () =>
                actions.openConfirmModal({
                  title: "Delete event",
                  message: `Delete "${band.event.name}" (${formatDateUk(band.event.startDate)}–${formatDateUk(band.event.endDate)})? This can be undone with Ctrl+Z immediately after.`,
                  confirmLabel: "Delete",
                  onConfirm: () => actions.deleteEvent(band.event.id, band.event.name),
                }),
            },
          ]);
        }}
      >
        <a
          href="/events"
          draggable={false}
          style={{ cursor: "grab", touchAction: "none" }}
          onClick={(e) => {
            // A real drag just finished — don't also follow the link.
            if (suppressNextEventClick) {
              e.preventDefault();
              suppressNextEventClick = false;
            }
          }}
          onPointerDown={(e) =>
            onEventPointerDown(e, {
              id: band.event.id,
              name: band.event.name,
              notes: band.event.notes ?? null,
              startDate: band.event.startDate,
              endDate: band.event.endDate,
            })
          }
          onPointerMove={onEventPointerMove}
          onPointerUp={(e) => onEventPointerUp(e, actions)}
          onPointerCancel={clearEventDragVisuals}
        >
          {band.continuesBefore ? "< " : ""}
          {band.event.name}
          {band.continuesAfter ? " >" : ""}
        </a>
      </td>
    );
  }
  return cells;
}
