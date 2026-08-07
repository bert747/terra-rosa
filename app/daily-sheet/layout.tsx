import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";

// No role restriction here on purpose — Daily Sheet is the one page a
// viewer IS allowed to see (see app/grid, /bookings, /events, /settings,
// /users, /history's own layouts, which all bounce viewers HERE). This
// guard only adds the plain "must be logged in" requirement every other
// page already had — Daily Sheet previously had no auth check at all.
export default async function DailySheetLayout({ children }: { children: React.ReactNode }) {
  let user;
  try {
    user = await requireUser();
  } catch {
    redirect("/login");
  }
  if (user.mustChangePassword) redirect("/change-password");
  return <>{children}</>;
}
