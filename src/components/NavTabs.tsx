"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavLink {
  href: string;
  label: string;
}

// ---------------------------------------------------------------------------
// The tab strip itself. Split out of <Nav /> as a client component purely so
// it can read the current path — <Nav /> stays a server component because it
// needs the session (getCurrentUser), which isn't available client-side.
//
// "Active" means the current path is the tab's href or a child of it, so
// /bookings/12 keeps the Bookings tab lit rather than lighting nothing.
// ---------------------------------------------------------------------------

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function NavTabs({ links }: { links: NavLink[] }) {
  const pathname = usePathname() ?? "";

  return (
    <div className="tr-tabs" role="tablist">
      {links.map((l) => {
        const active = isActive(pathname, l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`tr-tab${active ? " tr-tab-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}
