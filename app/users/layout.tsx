import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  // Stricter than the other sections: viewers have no business seeing the
  // account list, so they get bounced to the dashboard rather than /login.
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "editor") redirect("/dashboard");

  return <>{children}</>;
}
