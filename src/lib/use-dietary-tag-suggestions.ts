"use client";

import { useEffect, useState } from "react";
import { STANDARD_DIETARY_TAGS } from "@/lib/dietary-tags";

/**
 * STANDARD_DIETARY_TAGS plus every custom tag already in use on at least
 * one booking — otherwise a custom tag typed on one booking (e.g.
 * "Shellfish-Allergy") never shows up as a suggestion when editing a
 * different one, so staff either retype it by hand every time or
 * accidentally create near-duplicates ("Shellfish allergy" vs
 * "Shellfish-Allergy").
 */
export function useDietaryTagSuggestions(): string[] {
  const [custom, setCustom] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/bookings")
      .then((r) => r.json())
      .then((rows: { dietariesTags: string[] | null }[]) => {
        const seen = new Set(STANDARD_DIETARY_TAGS.map((t) => t.toLowerCase()));
        const extra: string[] = [];
        for (const row of rows) {
          for (const tag of row.dietariesTags ?? []) {
            const key = tag.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              extra.push(tag);
            }
          }
        }
        setCustom(extra.sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {});
  }, []);

  return [...STANDARD_DIETARY_TAGS, ...custom];
}
