"use client";

import { useEffect, useState } from "react";

export interface GuestCategory {
  id: number;
  name: string;
  colour: string;
  rank: number;
  active: boolean;
}

/**
 * Every guest category, active and inactive. A booking form/picker should
 * filter to `.active` itself (see GuestTypeSelect) — this hook returns the
 * full list rather than pre-filtering because some callers (the grid pill,
 * anything rendering an EXISTING booking's colour/label) must still resolve
 * a since-deactivated category correctly.
 */
export function useGuestCategories(): GuestCategory[] {
  const [categories, setCategories] = useState<GuestCategory[]>([]);

  useEffect(() => {
    fetch("/api/guest-categories")
      .then((r) => r.json())
      .then((rows: GuestCategory[]) => setCategories(rows))
      .catch(() => {});
  }, []);

  return categories;
}
