"use client";

import { COLOUR_PRESETS } from "@/lib/colour-presets";

/**
 * A row of preset swatches (matching the site's own muted palette — see
 * COLOUR_PRESETS) plus a plain native colour input for anything outside
 * that set. Shared between Guest Categories and Events, the two places a
 * colour is picked directly by staff rather than derived automatically.
 */
export default function ColourPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {COLOUR_PRESETS.map((hex) => (
        <button
          key={hex}
          type="button"
          aria-label={hex}
          onClick={() => onChange(hex)}
          style={{
            width: 24,
            height: 24,
            padding: 0,
            minHeight: "unset",
            borderRadius: 6,
            background: hex,
            // A ring around the currently-selected swatch — thicker/darker
            // border rather than a checkmark, so it reads at this small a
            // size without extra iconography.
            border: value.toLowerCase() === hex.toLowerCase() ? "2px solid var(--tr-text)" : "1px solid rgba(0, 0, 0, 0.15)",
            cursor: "pointer",
          }}
        />
      ))}
      <input
        type="color"
        aria-label="Custom colour"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 28, height: 28, padding: 0, minHeight: "unset", border: "1px solid var(--tr-border)" }}
      />
    </div>
  );
}
