"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDateUk, isIsoDate, parseUkDateToIso } from "@/lib/dates";
import { addDays } from "@/lib/occupancy";

interface DateFieldProps {
  /** ISO (yyyy-mm-dd) or "" for empty. */
  value: string;
  onChange: (iso: string) => void;
  required?: boolean;
  autoFocus?: boolean;
  style?: React.CSSProperties;
}

/**
 * Turns a run of digits (no slashes typed) into a dd/mm/yyyy guess, so
 * typing "5826" reads as day 5, month 8, year 2026 without the user typing
 * any slashes. Rule: the last 2 digits are the year (assumed 20YY) unless
 * there are 7+ digits, in which case the last 4 are the year; whatever's
 * left before that splits into day (first half, max 2 digits) then month
 * (the rest). Purely a display nicety — parseUkDateToIso still does the
 * real validation once slashes are in place.
 */
function maskDigitsAsUkDate(digits: string): string {
  const d = digits.slice(0, 8);
  if (d.length <= 2) return d;

  const yearLen = d.length >= 7 ? 4 : 2;
  const yearDigits = d.slice(-yearLen);
  const rest = d.slice(0, -yearLen);
  const year = yearLen === 2 ? `20${yearDigits}` : yearDigits;

  if (rest.length === 0) return d;
  const dayLen = Math.min(2, Math.ceil(rest.length / 2));
  const day = rest.slice(0, dayLen);
  const month = rest.slice(dayLen);

  if (month.length === 0) return `${day}/`;
  return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
}

/**
 * A native `<input type="date">` renders in whatever format the visitor's
 * OS/browser locale dictates (often mm/dd/yyyy) — the page's own `lang`
 * attribute has no effect on that in Chromium, so it can't be forced to
 * dd/mm/yyyy that way. This is a plain text field instead: always
 * dd/mm/yyyy, parsed via parseUkDateToIso. Local text state so a
 * partially-typed date (e.g. "05/0") doesn't get clobbered by the
 * formatted value on every keystroke; onChange only fires once the text
 * parses to a complete valid date, and onBlur snaps the display back to
 * the canonical formatting (clearing any leftover invalid text).
 *
 * Also supports: typing digits with no slashes (auto-masked into
 * dd/mm/yyyy, see maskDigitsAsUkDate), Up/Down arrow keys to step the date
 * by a day, and a calendar button that opens a small popover picker.
 */
export default function DateField({ value, onChange, required, autoFocus, style }: DateFieldProps) {
  const [text, setText] = useState(() => formatDateUk(value));
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setText(formatDateUk(value));
  }, [value]);

  useEffect(() => {
    if (!pickerOpen) return;
    function handlePointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPickerOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [pickerOpen]);

  function applyText(raw: string) {
    setText(raw);
    if (raw.trim() === "") {
      onChange("");
      return;
    }
    const iso = parseUkDateToIso(raw);
    if (iso) onChange(iso);
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 4 }}>
      <input
        type="text"
        inputMode="numeric"
        placeholder="dd/mm/yyyy"
        required={required}
        autoFocus={autoFocus}
        style={{ width: 100, ...style }}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          // Only auto-mask when the user hasn't typed a slash themselves —
          // once a "/" is present, respect it exactly (normal typing path).
          if (raw !== "" && !raw.includes("/") && /^\d+$/.test(raw)) {
            applyText(maskDigitsAsUkDate(raw));
            return;
          }
          applyText(raw);
        }}
        onBlur={() => setText(formatDateUk(value))}
        onKeyDown={(e) => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          if (!isIsoDate(value)) return;
          e.preventDefault();
          const next = addDays(value, e.key === "ArrowUp" ? 1 : -1);
          onChange(next);
        }}
      />
      <button
        type="button"
        aria-label="Open calendar"
        onClick={() => setPickerOpen((v) => !v)}
        // Explicit height (not minHeight) matching the adjacent text
        // input's own actual RENDERED height (42px, box-sizing: border-box
        // on both — see globals.css) — padding-based sizing alone doesn't
        // reliably match a text input's height, since a text field's line
        // box (from its font metrics) and an icon's own fixed pixel size
        // don't grow the same way from identical padding. This is also
        // duplicated in app/daily-sheet/page.tsx's own calendar button —
        // fix both together if this ever changes.
        style={{ height: 42, padding: "0 10px", lineHeight: 1, display: "inline-flex", alignItems: "center" }}
      >
        <CalendarIcon />
      </button>
      {pickerOpen && (
        <CalendarPopover
          value={isIsoDate(value) ? value : null}
          onPick={(iso) => {
            onChange(iso);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

// Plain line-art icon in currentColor — an emoji calendar glyph (📅) renders
// as a full-colour system icon (red/white) that clashes with the app's flat
// muted palette everywhere else, so this stays monochrome like the rest of
// the button chrome. Exported so other bare calendar-icon buttons (e.g. the
// Daily Sheet's date nav rows) can match this exact icon instead of reaching
// for the emoji themselves.
export function CalendarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" />
      <line x1="1.5" y1="6" x2="14.5" y2="6" />
      <line x1="4.5" y1="1" x2="4.5" y2="3.5" />
      <line x1="11.5" y1="1" x2="11.5" y2="3.5" />
    </svg>
  );
}

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function CalendarPopover({ value, onPick }: { value: string | null; onPick: (iso: string) => void }) {
  const [monthCursor, setMonthCursor] = useState<{ year: number; month: number }>(() => {
    const base = value ? new Date(`${value}T00:00:00Z`) : new Date();
    return { year: base.getUTCFullYear(), month: base.getUTCMonth() };
  });
  const ref = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    setOffset({ x: overflowX > 0 ? -overflowX - 4 : 0, y: 0 });
  }, []);

  const first = new Date(Date.UTC(monthCursor.year, monthCursor.month, 1));
  const startWeekday = (first.getUTCDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(Date.UTC(monthCursor.year, monthCursor.month + 1, 0)).getUTCDate();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${monthCursor.year}-${String(monthCursor.month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    cells.push(iso);
  }

  function shiftMonth(delta: number) {
    setMonthCursor((c) => {
      const d = new Date(Date.UTC(c.year, c.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  return (
    <div
      ref={ref}
      className="tr-context-menu"
      style={{ position: "absolute", top: "calc(100% + 4px)", left: offset.x, zIndex: 50, padding: 8, width: 220 }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
        <button type="button" onClick={() => shiftMonth(-1)} style={{ minHeight: "unset", padding: "2px 8px" }}>
          ‹
        </button>
        <span style={{ flex: 1, textAlign: "center", fontSize: 12, fontWeight: 600 }}>
          {first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
        </span>
        <button type="button" onClick={() => shiftMonth(1)} style={{ minHeight: "unset", padding: "2px 8px" }}>
          ›
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, fontSize: 11 }}>
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="tr-muted" style={{ textAlign: "center" }}>
            {w}
          </div>
        ))}
        {cells.map((iso, i) => (
          <button
            key={i}
            type="button"
            disabled={!iso}
            onClick={() => iso && onPick(iso)}
            style={{
              minHeight: "unset",
              padding: "4px 0",
              visibility: iso ? "visible" : "hidden",
              background: iso && iso === value ? "var(--tr-accent-soft)" : undefined,
              fontWeight: iso && iso === value ? 700 : 400,
            }}
          >
            {iso ? Number(iso.slice(-2)) : ""}
          </button>
        ))}
      </div>
    </div>
  );
}
