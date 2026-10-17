"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const path = usePathname();
  if (path === "/login") return null;
  const link = (href: string, label: string) => (
    <Link href={href} className={path === href ? "active" : undefined}>
      {label}
    </Link>
  );
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        Insta Agent
      </Link>
      <nav>
        {link("/", "Jobs")}
        {link("/settings", "Settings")}
        <a href="/api/logout">Log out</a>
      </nav>
    </header>
  );
}
