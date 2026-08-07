/** Shared name/startDate/endDate/notes/colour parsing for the events POST and PATCH routes. */
export function parseEventBody(body: unknown) {
  const payload = (body ?? {}) as Record<string, unknown>;
  const name = String(payload.name ?? "").trim();
  const startDate = String(payload.startDate ?? "");
  const endDate = String(payload.endDate ?? "");
  const notes = String(payload.notes ?? "").trim() || null;
  // Nullable — see the schema column's own comment. Only overwritten when
  // the request actually sends a colour key at all, so a PATCH that's just
  // renaming an event doesn't accidentally clear its colour back to null.
  const colour = "colour" in payload ? (String(payload.colour ?? "").trim() || null) : undefined;
  return { name, startDate, endDate, notes, colour };
}
