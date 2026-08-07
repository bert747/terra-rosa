import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const user = await getCurrentUser();
  if (user?.mustChangePassword) redirect("/change-password");
  redirect(user ? "/grid" : "/login");
}
