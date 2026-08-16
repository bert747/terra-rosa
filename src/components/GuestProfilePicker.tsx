"use client";

import { useEffect, useRef, useState } from "react";

export interface GuestProfile {
  id: number;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  dietariesTags: unknown;
}

/**
 * Search-or-create control for linking a booking to a reusable guest
 * profile (see the `guests` table's own schema comment for why this exists
 * — the motivating case is not re-typing a returning guest's dietary needs
 * every time). There is never a "suggested match" or automatic linking,
 * only an explicit search or an explicit "save as a new profile" — staff
 * decide when two bookings are really the same person, this never guesses.
 *
 * Two different flows share this same component:
 *   - New Booking: every booking ends up linked to SOME profile. This
 *     component only ever handles the "link to an existing one" half —
 *     the "or create a new one" half isn't a checkbox here at all, it's a
 *     confirm-before-saving popup one level up (see app/bookings/new/
 *     page.tsx), since there's no such thing as "new booking, no profile"
 *     to opt out of. Pass `showCreateCheckbox={false}` for this case.
 *   - Editing an existing (pre-this-feature) booking: linking one is
 *     optional, never forced — the checkbox below is the ONLY way that
 *     happens, and only on save, not automatically.
 *
 * Owns only its OWN UI state (the search box); the actual link — which
 * guest is selected, whether "create new" is checked — lives in the parent
 * form's own state, since picking a guest also has to overwrite the name/
 * dietary fields sitting right next to this component, and only the parent
 * owns those.
 */
export default function GuestProfilePicker({
  linkedGuest,
  createNew,
  onSelect,
  onUnlink,
  onToggleCreateNew,
  showCreateCheckbox = true,
}: {
  /** The currently-linked EXISTING guest, or null if this booking isn't linked (or is queued to create a new one — see createNew). */
  linkedGuest: GuestProfile | null;
  /** Queued to create a brand-new profile from this booking's current fields on save. Mutually exclusive with linkedGuest. Ignored when showCreateCheckbox is false. */
  createNew: boolean;
  onSelect: (guest: GuestProfile) => void;
  onUnlink: () => void;
  onToggleCreateNew: (value: boolean) => void;
  /** See the New-Booking-vs-editing note above. Default true (the editing case) since that's the more common caller by count of forms. */
  showCreateCheckbox?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GuestProfile[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/guests?q=${encodeURIComponent(q)}`);
        if (!active) return;
        setResults(res.ok ? await res.json() : []);
      } catch {
        if (active) setResults([]);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function guestLabel(g: GuestProfile): string {
    const name = `${g.firstName} ${g.lastName}`.trim();
    return g.preferredName ? `${name} (${g.preferredName})` : name;
  }

  if (linkedGuest) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span className="tr-badge" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          👤 Linked to guest profile: <strong>{guestLabel(linkedGuest)}</strong>
        </span>
        <button type="button" onClick={onUnlink}>Unlink</button>
      </div>
    );
  }

  return (
    <div ref={boxRef} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ position: "relative" }}>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search existing guest profiles…"
          style={{ width: "100%" }}
        />
        {open && query.trim() && (
          <div
            className="tr-actions-menu"
            style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 20, maxHeight: 220, overflowY: "auto" }}
          >
            {results.length === 0 ? (
              <div className="tr-muted" style={{ padding: "8px 10px", fontSize: 13 }}>No matching guest profiles.</div>
            ) : (
              results.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  className="tr-actions-menu-item"
                  style={{ width: "100%", textAlign: "left", display: "block" }}
                  onClick={() => {
                    onSelect(g);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  {guestLabel(g)}
                  {Array.isArray(g.dietariesTags) && g.dietariesTags.length > 0 && (
                    <span className="tr-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                      {(g.dietariesTags as string[]).join(", ")}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {showCreateCheckbox && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }} className="tr-muted">
          <input type="checkbox" checked={createNew} onChange={(e) => onToggleCreateNew(e.target.checked)} />
          Save this guest&apos;s info to a reusable profile (so it can be pulled onto their next booking)
        </label>
      )}
    </div>
  );
}
