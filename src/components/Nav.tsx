import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import NavTabs, { type NavLink } from "@/components/NavTabs";

// Every logged-in user gets Daily Sheet — it's the one page a viewer is
// allowed to see (see the matching redirect in grid/bookings/events/
// settings/users/history's own layouts), so it's the only link shown
// unconditionally rather than living in LINKS below.
const VIEWER_LINKS: NavLink[] = [{ href: "/daily-sheet", label: "Daily Sheet" }];

// Editor-only sections, appended for editors.
const EDITOR_LINKS: NavLink[] = [
  { href: "/grid", label: "Grid" },
  { href: "/bookings", label: "Bookings" },
  { href: "/events", label: "Events" },
  { href: "/daily-sheet", label: "Daily Sheet" },
  { href: "/settings/layout", label: "Layout" },
  { href: "/history", label: "History" },
  { href: "/users", label: "Users" },
];

export default async function Nav() {
  const user = await getCurrentUser();

  return (
    <nav className="tr-nav tr-no-print">
      <div className="tr-nav-left">
        <strong className="tr-nav-brand">Terra Rosa</strong>
        <NavTabs links={user?.role === "editor" ? EDITOR_LINKS : VIEWER_LINKS} />
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
