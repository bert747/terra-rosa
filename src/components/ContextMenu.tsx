"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  title?: string;
  items: ContextMenuItem[];
}

/**
 * A fixed-position right-click menu. `position: fixed` (not absolute) so it
 * escapes the grid's scrollable viewport cleanly with no portal needed —
 * fixed positioning is relative to the browser viewport unless an ancestor
 * sets a transform, which nothing here does.
 */
export default function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Clamp to the viewport after first paint, once we know the menu's size.
  useLayoutEffect(() => {
    if (!state || !ref.current) {
      setOffset({ x: 0, y: 0 });
      return;
    }
    const rect = ref.current.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    const overflowY = rect.bottom - window.innerHeight;
    setOffset({ x: overflowX > 0 ? -overflowX - 4 : 0, y: overflowY > 0 ? -overflowY - 4 : 0 });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("contextmenu", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("contextmenu", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      ref={ref}
      className="tr-context-menu"
      style={{ top: state.y + offset.y, left: state.x + offset.x }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.title && <div className="tr-context-menu-title">{state.title}</div>}
      {state.items.map((item, i) => (
        <button
          key={i}
          type="button"
          className={`tr-context-menu-item${item.danger ? " tr-context-menu-item-danger" : ""}`}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
