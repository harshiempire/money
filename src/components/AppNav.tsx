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
  return (
    <nav className="flex flex-wrap items-center gap-4 text-sm text-neutral-600 dark:text-neutral-400">
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          className={
            current === l.href
              ? "font-medium text-neutral-900 dark:text-neutral-100"
              : "underline-offset-4 hover:underline"
          }
        >
          {l.label}
        </a>
      ))}
      <span className="ml-auto">
        <SignOutButton />
      </span>
    </nav>
  );
}
