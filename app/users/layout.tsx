import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  // Stricter than the other sections: viewers have no business seeing the
  // account list at all, so they're bounced to Daily Sheet — same target
  // every other viewer-restricted page uses (see grid/bookings/events/
  // settings/history's own layouts).
  if (user.role !== "editor") redirect("/daily-sheet");

  return <>{children}</>;
}
