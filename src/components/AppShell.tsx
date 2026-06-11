"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
import {
  IconHome,
  IconChart,
  IconList,
  IconFlag,
  IconClock,
  IconSwap,
  IconUsers,
  IconUpload,
  IconMore,
} from "./icons";

const NAV_GROUPS = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", icon: IconHome }],
  },
  {
    label: "Money",
    items: [
      { href: "/spend", label: "Spend", icon: IconChart },
      { href: "/transactions", label: "Transactions", icon: IconList },
      { href: "/review", label: "Review", icon: IconFlag },
      { href: "/timeline", label: "Timeline", icon: IconClock },
    ],
  },
  {
    label: "Settle",
    items: [
      { href: "/reimbursements", label: "Reimbursements", icon: IconSwap },
      { href: "/people", label: "People", icon: IconUsers },
    ],
  },
  {
    label: "Data",
    items: [{ href: "/import", label: "Import", icon: IconUpload }],
  },
] as const;

const MOBILE_TABS = [
  { href: "/", label: "Dashboard", icon: IconHome },
  { href: "/spend", label: "Spend", icon: IconChart },
  { href: "/transactions", label: "Transactions", icon: IconList },
  { href: "/reimbursements", label: "Settle", icon: IconSwap },
] as const;

const MORE_LINKS = [
  { href: "/review", label: "Review", icon: IconFlag },
  { href: "/timeline", label: "Timeline", icon: IconClock },
  { href: "/people", label: "People", icon: IconUsers },
  { href: "/import", label: "Import", icon: IconUpload },
] as const;

const WIDTH_CLASS = {
  default: "max-w-5xl",
  wide: "max-w-6xl",
  narrow: "max-w-2xl",
} as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(href + "/");
}

export function AppShell({
  title,
  width = "default",
  actions,
  children,
}: {
  title: ReactNode;
  width?: keyof typeof WIDTH_CLASS;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const navItemClass = (href: string) => {
    const active = isActive(pathname, href);
    return active
      ? "flex items-center gap-2 rounded px-2 py-1.5 text-sm font-medium text-neutral-900 bg-neutral-100 dark:bg-neutral-800 dark:text-neutral-100"
      : "flex items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800";
  };

  const tabClass = (href: string) => {
    const active = isActive(pathname, href);
    return active
      ? "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-neutral-900 dark:text-neutral-100"
      : "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-neutral-500";
  };

  const moreActive = MORE_LINKS.some((l) => isActive(pathname, l.href));

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 md:flex">
        <div className="flex flex-1 flex-col p-4">
          <a href="/" className="text-lg font-semibold">
            Money
          </a>
          <nav className="mt-6 space-y-5">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <a
                        key={item.href}
                        href={item.href}
                        className={navItemClass(item.href)}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          <div className="mt-auto space-y-2 pt-4">
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={`mx-auto w-full flex-1 p-8 pb-24 md:pb-8 ${WIDTH_CLASS[width]}`}
        >
          <header className="flex items-baseline justify-between gap-3">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {actions}
          </header>
          {children}
        </div>
      </div>

      {moreOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {moreOpen && (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950 md:hidden">
          <div className="space-y-0.5">
            {MORE_LINKS.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 rounded px-2 py-2 text-sm ${
                    isActive(pathname, item.href)
                      ? "font-medium text-neutral-900 dark:text-neutral-100"
                      : "text-neutral-600 dark:text-neutral-400"
                  }`}
                  onClick={() => setMoreOpen(false)}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </a>
              );
            })}
            <div className="my-2 border-t border-neutral-200 dark:border-neutral-800" />
            <div className="px-2 py-1">
              <ThemeToggle />
            </div>
            <div className="px-2 py-1">
              <SignOutButton />
            </div>
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-neutral-800 dark:bg-neutral-950 md:hidden">
        {MOBILE_TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <a key={tab.href} href={tab.href} className={tabClass(tab.href)}>
              <Icon className="h-5 w-5" />
              {tab.label}
            </a>
          );
        })}
        <button
          type="button"
          className={
            moreOpen || moreActive
              ? "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-neutral-900 dark:text-neutral-100"
              : "flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-neutral-500"
          }
          onClick={() => setMoreOpen((v) => !v)}
        >
          <IconMore className="h-5 w-5" />
          More
        </button>
      </nav>
    </div>
  );
}
