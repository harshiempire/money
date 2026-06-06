"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  IconDashboard,
  IconSpend,
  IconTransactions,
  IconReview,
  IconTimeline,
  IconReimbursements,
  IconPeople,
  IconImport,
  IconLogo,
  IconSignOut,
} from "@/components/icons";
import { SignOutButton } from "@/components/SignOutButton";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match?: (pathname: string) => boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Dashboard", icon: IconDashboard },
      { href: "/spend", label: "Spend report", icon: IconSpend },
      { href: "/timeline", label: "Timeline", icon: IconTimeline },
    ],
  },
  {
    label: "Transactions",
    items: [
      { href: "/transactions", label: "All transactions", icon: IconTransactions },
      { href: "/review", label: "Review queue", icon: IconReview },
    ],
  },
  {
    label: "People & splits",
    items: [
      { href: "/reimbursements", label: "Reimbursements", icon: IconReimbursements },
      { href: "/people", label: "People", icon: IconPeople, match: (p) => p.startsWith("/people") },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/import", label: "Import statement", icon: IconImport },
    ],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.match) return item.match(pathname);
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-raised)]">
      <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-5 py-4">
        <IconLogo />
        <div>
          <div className="text-sm font-semibold text-[var(--color-text)]">Money</div>
          <div className="text-[10px] text-[var(--color-text-muted)]">Net spend tracker</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {navGroups.map((group) => (
          <div key={group.label} className="mb-5">
            <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        "flex items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-[var(--color-accent-muted)] font-medium text-[var(--color-accent)]"
                          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-overlay)] hover:text-[var(--color-text)]",
                      )}
                    >
                      <Icon className={cn("shrink-0", active && "text-[var(--color-accent)]")} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--color-border)] p-3">
        <SignOutButton className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-overlay)] hover:text-[var(--color-text)]">
          <IconSignOut className="h-5 w-5" />
          Sign out
        </SignOutButton>
      </div>
    </aside>
  );
}
