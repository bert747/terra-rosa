import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function HistoryLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch {
    redirect("/login");
  }
  if (user.mustChangePassword) redirect("/change-password");
  // Viewers only get Daily Sheet — see the same check on grid/bookings/
  // events/settings/users' own layouts.
  if (user.role === "viewer") redirect("/daily-sheet");
  return <>{children}</>;
}
