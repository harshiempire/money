"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  IconDashboard,
  IconTransactions,
  IconReimbursements,
  IconImport,
  IconMenu,
} from "@/components/icons";

const tabs = [
  { href: "/", label: "Home", icon: IconDashboard },
  { href: "/transactions", label: "Txns", icon: IconTransactions },
  { href: "/reimbursements", label: "Splits", icon: IconReimbursements },
  { href: "/import", label: "Import", icon: IconImport },
];

export function MobileNav({ onMenuOpen }: { onMenuOpen: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-[var(--color-border)] bg-[var(--color-surface-raised)] pb-[env(safe-area-inset-bottom)] lg:hidden">
      {tabs.map((tab) => {
        const active =
          tab.href === "/"
            ? pathname === "/"
            : pathname === tab.href || pathname.startsWith(tab.href + "/");
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors",
              active
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-text-muted)]",
            )}
          >
            <Icon className="h-5 w-5" />
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMenuOpen}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-[var(--color-text-muted)]"
        aria-label="Open menu"
      >
        <IconMenu className="h-5 w-5" />
        More
      </button>
    </nav>
  );
}
