import { cn } from "@/lib/cn";

export function Card({
  className,
  children,
  padding = "md",
}: {
  className?: string;
  children: React.ReactNode;
  padding?: "none" | "sm" | "md" | "lg";
}) {
  const pad =
    padding === "none"
      ? ""
      : padding === "sm"
        ? "p-3"
        : padding === "lg"
          ? "p-6"
          : "p-4";

  return (
    <div
      className={cn(
        "rounded-lg border border-border-subtle bg-surface-raised shadow-[var(--shadow-card)] dark:shadow-[var(--shadow-card-dark)]",
        pad,
        className,
      )}
    >
      {children}
    </div>
  );
}
