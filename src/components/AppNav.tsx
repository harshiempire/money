"use client";

import { useState } from "react";
import { SignOutButton } from "./SignOutButton";

type NavLink = { href: string; label: string };

const defaultLinks: NavLink[] = [
  { href: "/", label: "Dashboard" },
  { href: "/spend", label: "Spend" },
  { href: "/transactions", label: "Transactions" },
  { href: "/review", label: "Review" },
  { href: "/timeline", label: "Timeline" },
  { href: "/reimbursements", label: "Reimbursements" },
  { href: "/import", label: "Import" },
];

export function AppNav({
  links = defaultLinks,
  current,
}: {
  links?: NavLink[];
  current?: string;
}) {
  const [open, setOpen] = useState(false);

  const linkClass = (href: string) => {
    const active = current === href;
    return active
      ? "block rounded bg-neutral-100 px-2 py-1.5 font-medium text-neutral-900 underline decoration-neutral-400 underline-offset-4 dark:bg-neutral-800 dark:text-neutral-100 dark:decoration-neutral-500"
      : "block rounded px-2 py-1.5 text-neutral-600 underline-offset-4 hover:bg-neutral-100 hover:underline dark:text-neutral-400 dark:hover:bg-neutral-800";
  };

  return (
    <div className="relative flex shrink-0 items-start gap-2">
      <button
        type="button"
        className="rounded border border-neutral-300 px-2 py-1 text-sm md:hidden dark:border-neutral-700"
        aria-expanded={open}
        aria-controls="app-nav-menu"
        onClick={() => setOpen((v) => !v)}
      >
        Menu
      </button>

      <nav
        id="app-nav-menu"
        className={`${
          open ? "flex" : "hidden"
        } absolute top-full right-0 z-20 mt-1 min-w-[11rem] flex-col gap-0.5 rounded border border-neutral-200 bg-white p-2 text-sm shadow-lg md:static md:mt-0 md:flex md:min-w-0 md:flex-row md:flex-wrap md:items-center md:gap-4 md:border-0 md:bg-transparent md:p-0 md:shadow-none dark:border-neutral-800 dark:bg-neutral-950 md:dark:bg-transparent`}
      >
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className={linkClass(l.href)}
            onClick={() => setOpen(false)}
          >
            {l.label}
          </a>
        ))}
        <span className="mt-1 border-t border-neutral-200 pt-2 md:mt-0 md:ml-auto md:border-0 md:pt-0 dark:border-neutral-800">
          <SignOutButton />
        </span>
      </nav>
    </div>
  );
}
