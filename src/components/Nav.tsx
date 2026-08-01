import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import NavTabs, { type NavLink } from "@/components/NavTabs";
import BackButton from "@/components/BackButton";

const LINKS: NavLink[] = [
  { href: "/grid", label: "Grid" },
  { href: "/bookings", label: "Bookings" },
  { href: "/events", label: "Events" },
];

// Editor-only sections, appended to LINKS for editors.
const EDITOR_LINKS: NavLink[] = [
  { href: "/settings/layout", label: "Layout" },
  { href: "/users", label: "Users" },
];

export default async function Nav() {
  const user = await getCurrentUser();

  return (
    <nav className="tr-nav">
      <div className="tr-nav-left">
        <BackButton />
        <strong className="tr-nav-brand">Terra Rosa</strong>
        <NavTabs links={[...LINKS, ...(user?.role === "editor" ? EDITOR_LINKS : [])]} />
      </div>
      <span style={{ flex: 1 }} />
      {user ? (
        <details className="tr-user-menu">
          <summary>
            {user.name} <span className="tr-muted">({user.role})</span>
          </summary>
          <div className="tr-user-menu-panel">
            <div className="tr-muted" style={{ marginBottom: 8 }}>Signed in as {user.email}</div>
            <form action="/api/auth/logout" method="post">
              <button type="submit" style={{ width: "100%" }}>Log out</button>
            </form>
          </div>
        </details>
      ) : (
        <Link href="/login">Log in</Link>
      )}
    </nav>
  );
}
