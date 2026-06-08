"use client";

import { usePathname } from "next/navigation";
import { SidebarNav } from "./SidebarNav";

const PUBLIC_PREFIXES = ["/login", "/register", "/api/"];

function isPublicRoute(pathname: string) {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

export function AppChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = isPublicRoute(pathname);

  if (isPublic) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen md:pl-60">
      <SidebarNav />
      <div className="min-h-screen bg-surface">{children}</div>
    </div>
  );
}
