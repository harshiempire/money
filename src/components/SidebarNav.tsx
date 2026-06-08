"use client";

import {
  ArrowLeftRight,
  Clock,
  FileUp,
  HandCoins,
  LayoutDashboard,
  List,
  Menu,
  PieChart,
  Users,
  X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { SignOutButton } from "./SignOutButton";

type NavLink = { href: string; label: string; icon: React.ReactNode };

const links: NavLink[] = [
  { href: "/", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
  { href: "/spend", label: "Spend", icon: <PieChart size={18} /> },
  { href: "/transactions", label: "Transactions", icon: <List size={18} /> },
  { href: "/review", label: "Review", icon: <Clock size={18} /> },
  { href: "/timeline", label: "Timeline", icon: <ArrowLeftRight size={18} /> },
  {
    href: "/reimbursements",
    label: "Reimbursements",
    icon: <HandCoins size={18} />,
  },
  { href: "/people", label: "People", icon: <Users size={18} /> },
  { href: "/import", label: "Import", icon: <FileUp size={18} /> },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavItems({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {links.map((link) => {
        const active = isActive(pathname, link.href);
        return (
          <li key={link.href}>
            <a
              href={link.href}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                active
                  ? "bg-surface-muted font-medium text-neutral-900 dark:text-neutral-50"
                  : "text-neutral-600 hover:bg-surface-muted/70 dark:text-neutral-400",
              )}
            >
              <span
                className={cn(
                  active
                    ? "text-neutral-800 dark:text-neutral-200"
                    : "text-neutral-400",
                )}
              >
                {link.icon}
              </span>
              {link.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="fixed top-4 left-4 z-40 inline-flex items-center gap-2 rounded-md border border-border-default bg-surface-raised px-3 py-2 text-sm shadow-[var(--shadow-card)] md:hidden"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((v) => !v)}
      >
        {mobileOpen ? <X size={16} /> : <Menu size={16} />}
        Menu
      </button>

      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-sidebar-border bg-sidebar transition-transform md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-b border-sidebar-border px-4 py-5">
          <a href="/" className="block" onClick={() => setMobileOpen(false)}>
            <span className="text-lg font-semibold tracking-tight">Money</span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              Split-aware net spend
            </span>
          </a>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <NavItems
            pathname={pathname}
            onNavigate={() => setMobileOpen(false)}
          />
        </nav>

        <div className="border-t border-sidebar-border px-4 py-4 text-sm">
          <SignOutButton />
        </div>
      </aside>
    </>
  );
}
