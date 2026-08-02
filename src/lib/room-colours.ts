// ---------------------------------------------------------------------------
// Per-room colour banding for the grid.
//
// The grid shows one row per bed, so a room with six beds is six adjacent
// rows. Without banding it's genuinely hard to tell, scanning down a column,
// where the dorm ends and the next room starts. Each room therefore gets a
// tint from this palette, cycled by position in the room list, and every bed
// row belonging to that room carries it.
//
// Two shades per entry:
//   * `tint`  — very light, used behind free bed/night cells. It has to sit
//               under black 12px text and still read as "empty", so it stays
//               close to white.
//   * `label` — stronger, used for the sticky room/bed name cells, where the
//               block of colour is the thing doing the grouping work.
//
// Colours are deliberately desaturated: this grid already uses colour to mean
// things (arrival, departure, over-capacity, non-counting booking), and room
// identity must not shout over any of that.
// ---------------------------------------------------------------------------

export interface RoomColour {
  tint: string;
  label: string;
}

const PALETTE: RoomColour[] = [
  { tint: "#f7f5f3", label: "#e7e2dc" }, // warm stone
  { tint: "#f8f4f0", label: "#ecdfd2" }, // pale taupe
  { tint: "#f9f6ec", label: "#efe6cc" }, // soft ecru
  { tint: "#f1f4f7", label: "#dde6ee" }, // muted slate
  { tint: "#f5f3ef", label: "#e4ddd0" }, // subtle greige
  { tint: "#f2f6ef", label: "#dde8d2" }, // dusty sage
  { tint: "#f9f1ee", label: "#edd9d0" }, // soft clay
  { tint: "#f9f5ee", label: "#ede0c8" }, // warm sand
  { tint: "#f1f5ee", label: "#dde6d3" }, // faded moss
  { tint: "#f6f4f1", label: "#e6dfd6" }, // pale mushroom
];

/** The colour pair for the room at `index` in the displayed room order. */
export function roomColour(index: number): RoomColour {
  return PALETTE[index % PALETTE.length];
}

/**
 * Inline CSS custom properties to hang on a bed row's <tr>. The stylesheet
 * reads `--tr-room-tint` / `--tr-room-label` rather than hard-coding colours,
 * so occupied-cell rules can still override the tint by setting
 * `background-color` directly.
 */
export function roomColourStyle(index: number): React.CSSProperties {
  const { tint, label } = roomColour(index);
  return {
    ["--tr-room-tint" as string]: tint,
    ["--tr-room-label" as string]: label,
  } as React.CSSProperties;
}

// ---------------------------------------------------------------------------
// Event band colours — a separate, more saturated palette, because an event
// band is a foreground object rather than a background wash.
// ---------------------------------------------------------------------------

export interface EventColour {
  bg: string;
  border: string;
}

const EVENT_PALETTE: EventColour[] = [
  { bg: "#dbe7f6", border: "#8ea9cc" },
  { bg: "#e3dcf3", border: "#a294c9" },
  { bg: "#d9eddd", border: "#8ab596" },
  { bg: "#f8e4c9", border: "#ceab77" },
  { bg: "#f5d8dd", border: "#cc909c" },
  { bg: "#d5ebef", border: "#84b3bb" },
];

/** Stable band colour for an event, keyed off its id so it never shuffles. */
export function eventColour(eventId: number): EventColour {
  return EVENT_PALETTE[Math.abs(eventId) % EVENT_PALETTE.length];
}

export function eventColourStyle(eventId: number): React.CSSProperties {
  const { bg, border } = eventColour(eventId);
  return {
    ["--tr-event-bg" as string]: bg,
    ["--tr-event-border" as string]: border,
  } as React.CSSProperties;
}
