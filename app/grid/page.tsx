import GridCanvas from "@/components/GridCanvas";
import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { loadGridData } from "@/lib/grid-data";
import { addDays } from "@/lib/occupancy";

export const dynamic = "force-dynamic";

// Kept in sync with ROLLING_WINDOW_DAYS in GridCanvas.tsx — the client rolls
// this same ~60-day window as you scroll, rather than growing it.
const INITIAL_FETCH_DAYS = 60;

export default async function GridPage() {
  try {
    await requireUser();
  } catch {
    redirect("/login");
  }

  const today = new Date().toISOString().slice(0, 10);
  const initialStart = addDays(today, -Math.floor(INITIAL_FETCH_DAYS / 2));
  const initialData = await loadGridData(initialStart, INITIAL_FETCH_DAYS);

  return (
    <div>
      <div className="tr-shell">
        <GridCanvas initialData={initialData} today={today} />
      </div>
    </div>
  );
}
