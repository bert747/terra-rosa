import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  // Viewers only get Daily Sheet — see the same check on grid/bookings/
  // events/users/history's own layouts. Distinct from "not logged in at
  // all" (above), which should still land on /login, not /daily-sheet.
  if (user.role !== "editor") redirect("/daily-sheet");
  return <>{children}</>;
}
