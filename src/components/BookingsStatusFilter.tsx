"use client";

import { useRouter, useSearchParams } from "next/navigation";

const STATUS_OPTIONS = ["draft", "confirmed", "cancelled"] as const;
type StatusOption = (typeof STATUS_OPTIONS)[number];

export default function BookingsStatusFilter({ selectedStatuses }: { selectedStatuses: StatusOption[] }) {
  const router = useRouter();
  const search = useSearchParams();

  function toggleStatus(next: StatusOption, checked: boolean) {
    const params = new URLSearchParams(search.toString());
    const current = params.getAll("status");
    const nextValues = current.filter((value): value is StatusOption => STATUS_OPTIONS.includes(value as StatusOption));

    const updated = checked
      ? [...new Set([...nextValues, next])]
      : nextValues.filter((value) => value !== next);

    params.delete("status");
    updated.forEach((value) => params.append("status", value));

    const query = params.toString();
    router.push(query ? `/bookings?${query}` : "/bookings");
  }

  const selected = new Set(selectedStatuses);

  return (
    <div style={{ marginRight: 8, display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>Status</span>
      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={selected.has("draft")}
          onChange={(e) => toggleStatus("draft", e.target.checked)}
        />
        Draft
      </label>
      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={selected.has("confirmed")}
          onChange={(e) => toggleStatus("confirmed", e.target.checked)}
        />
        Confirmed
      </label>
      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={selected.has("cancelled")}
          onChange={(e) => toggleStatus("cancelled", e.target.checked)}
        />
        Cancelled
      </label>
    </div>
  );
}
