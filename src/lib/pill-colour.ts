// Shared by GridCanvas.tsx's bookingColourVars and the Layout settings
// page's guestCategoryColourVars — see either's own longer comment for why
// --tr-booking-color/-fill/-border all have to be set explicitly here in
// JS rather than left to globals.css's own nested color-mix() to pick up an
// override (it won't re-resolve against a closer one on the same element).
function hexLightness(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const num = parseInt(m[1], 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  // Perceived brightness (not real WCAG relative luminance — this only
  // needs to be good enough to threshold "is this basically white").
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function pillColourVars(colour: string): Record<string, string> {
  return {
    "--tr-booking-color": colour,
    "--tr-booking-fill": `color-mix(in srgb, ${colour} 24%, white)`,
    "--tr-booking-border": `color-mix(in srgb, ${colour} 82%, black 18%)`,
    // A saturated colour's border already reads clearly at 1px. A very
    // light colour — white chief among them — needs a visibly thicker line
    // to read as "a pill with a border" at all; at the same 1px it looked
    // smaller/fainter than every other colour next to it, even though the
    // box itself is the same size.
    "--tr-booking-border-width": (hexLightness(colour) ?? 0) > 0.85 ? "2px" : "1px",
  };
}
