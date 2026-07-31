import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function GuardiansLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireUser();
  } catch {
    redirect("/login");
  }

  return <>{children}</>;
}
