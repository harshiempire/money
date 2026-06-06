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
  const paddingClass = {
    none: "",
    sm: "p-3",
    md: "p-4",
    lg: "p-6",
  }[padding];

  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-sm)]",
        paddingClass,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
