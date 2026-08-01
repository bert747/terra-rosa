// A bed's type string is free text (see the layout settings page), but a
// type containing "1.5" or "double" (case-insensitive) sleeps two — this is
// the one place that rule is decided, so the grid and booking UI can't drift
// out of sync on what counts as a two-person bed.
export function bedCapacity(type: string): number {
  const normalised = type.toLowerCase();
  if (normalised.includes("1.5") || normalised.includes("double")) return 2;
  return 1;
}
