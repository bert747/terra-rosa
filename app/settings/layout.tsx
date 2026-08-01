import { requireEditor } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireEditor();
  } catch {
    redirect("/login");
  }
  return <>{children}</>;
}
