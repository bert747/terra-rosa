"use client";

import { useEffect, useState } from "react";

const OFFSET_X = 8; // px to the right of the cursor
const OFFSET_Y = 6; // px above the cursor

interface TooltipTarget {
  text: string;
  x: number;
  y: number;
}

/**
 * Single global replacement for the browser's native `title` tooltip — see
 * globals.css's own doc comment on .tr-tooltip-bubble for why this has to be
 * a real, `position: fixed` DOM node (rendered once here, not per-trigger)
 * rather than a CSS ::after on each element: most triggers live inside grid
 * table cells with their own `overflow: hidden`, which would clip a
 * pseudo-element tooltip before it ever became visible.
 *
 * Follows the CURSOR (opens just above and to the right of wherever it is
 * over the trigger), not the trigger element's own center — a booking pill
 * can be many columns wide, and anchoring to its middle put the tooltip far
 * from wherever staff actually hovered.
 *
 * Any element anywhere in the app just needs `data-tooltip="some text"` —
 * this listens globally (event delegation via the capture phase, so it
 * catches pointer/focus events regardless of what else on the page stops
 * their bubbling) and shows/hides/repositions the one shared bubble
 * accordingly.
 */
export default function TooltipHost() {
  const [target, setTarget] = useState<TooltipTarget | null>(null);

  useEffect(() => {
    // While a pointer button is held — dragging a booking, resizing it,
    // panning the grid, whatever — a tooltip popping up under the pointer
    // is just noise, and (worse) actively misleading when it's reporting
    // stale info about whatever the drag is currently hovering over rather
    // than the thing being dragged. Tracked here rather than reaching into
    // the grid's own drag state, which this component has no visibility
    // into and shouldn't need to: "a button is down" is a reasonable,
    // fully generic stand-in for "a drag might be happening," true for
    // every drag gesture in the app, not just the grid's.
    let pointerIsDown = false;

    function findTooltipEl(start: EventTarget | null): HTMLElement | null {
      if (!(start instanceof Element)) return null;
      return start.closest<HTMLElement>("[data-tooltip]");
    }

    function hide() {
      setTarget(null);
    }

    // pointermove fires continuously while hovering (no button needed) —
    // used as the single source of truth for both showing/hiding AND
    // tracking position, so the bubble visibly follows the cursor around
    // inside a wide pill instead of freezing wherever it first appeared.
    function onPointerMove(e: PointerEvent) {
      if (pointerIsDown) return;
      const el = findTooltipEl(e.target);
      if (!el) {
        hide();
        return;
      }
      const text = el.getAttribute("data-tooltip");
      if (!text) {
        hide();
        return;
      }
      setTarget({ text, x: e.clientX, y: e.clientY });
    }
    function onPointerDownTracked() {
      pointerIsDown = true;
      hide();
    }
    function onPointerUpOrCancel() {
      pointerIsDown = false;
    }
    // Keyboard focus has no cursor position to anchor to — falls back to
    // just above the focused element's own top-left corner.
    function onFocusIn(e: FocusEvent) {
      const el = findTooltipEl(e.target);
      if (!el) return;
      const text = el.getAttribute("data-tooltip");
      if (!text) {
        hide();
        return;
      }
      const rect = el.getBoundingClientRect();
      setTarget({ text, x: rect.left, y: rect.top });
    }
    function onFocusOut() {
      hide();
    }
    // A hovered element's own position can move out from under a static
    // tooltip (grid horizontal/vertical scroll, page scroll) — rather than
    // tracking every scrollable ancestor, just hide on any scroll; it'll
    // reappear on the next real hover.
    function onScroll() {
      hide();
    }

    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onPointerDownTracked, true);
    document.addEventListener("pointerup", onPointerUpOrCancel, true);
    document.addEventListener("pointercancel", onPointerUpOrCancel, true);
    return () => {
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointerDownTracked, true);
      document.removeEventListener("pointerup", onPointerUpOrCancel, true);
      document.removeEventListener("pointercancel", onPointerUpOrCancel, true);
    };
  }, []);

  if (!target) return null;

  const { x, y, text } = target;

  return (
    <div
      className="tr-tooltip-bubble"
      // top + translateY(-100%) instead of computing `bottom` from
      // window.innerHeight — puts the bubble's bottom-left corner exactly
      // OFFSET_X/Y away from the real (x, y) cursor point with no extra
      // arithmetic to get subtly wrong (scrollbar width, innerHeight vs.
      // the visual viewport, etc.), which was landing the bubble much
      // further from the cursor than the small offset was supposed to.
      style={{
        left: x + OFFSET_X,
        top: y - OFFSET_Y,
        transform: "translateY(-100%)",
      }}
    >
      {text}
    </div>
  );
}
