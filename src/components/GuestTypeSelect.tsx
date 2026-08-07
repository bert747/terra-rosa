"use client";

import { useState } from "react";
import type { GuestCategory } from "@/lib/use-guest-categories";

/**
 * A guest-type picker styled like the surrounding plain <select>s, but a
 * real hand-built dropdown rather than a native <select> — the native
 * element's hovered/selected <option> highlight is OS-drawn (system blue on
 * most platforms) and CSS genuinely cannot restyle it cross-browser, which
 * fought against the whole point of colour-coding these options in the
 * first place. Each row here is styled with its own category colour
 * (lightly tinted at rest, more saturated on hover) instead.
 */
export default function GuestTypeSelect({
  categories,
  value,
  onChange,
}: {
  categories: GuestCategory[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = categories.find((c) => String(c.id) === value);

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="tr-guest-type-trigger"
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, textAlign: "left" }}
      >
        {selected ? (
          <>
            <span aria-hidden="true" className="tr-guest-type-swatch" style={{ background: selected.colour }} />
            {selected.name}
          </>
        ) : (
          <span className="tr-muted">—</span>
        )}
        <span aria-hidden="true" style={{ marginLeft: "auto", opacity: 0.6, fontSize: 11 }}>▾</span>
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 29 }} onClick={() => setOpen(false)} />
          <ul className="tr-guest-type-menu" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 30 }}>
            <li onClick={() => pick("")} className="tr-guest-type-option tr-guest-type-option-none">
              <span className="tr-muted">—</span>
            </li>
            {categories.map((c) => (
              <li
                key={c.id}
                onClick={() => pick(String(c.id))}
                className="tr-guest-type-option"
                style={{ ["--option-colour" as string]: c.colour } as React.CSSProperties}
              >
                <span aria-hidden="true" className="tr-guest-type-swatch" style={{ background: c.colour }} />
                {c.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
