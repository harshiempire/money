import { cn } from "@/lib/cn";

export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "debit" | "credit" | "warning" | "neutral";
  className?: string;
}) {
  const toneClass = {
    debit: "text-[var(--color-debit)]",
    credit: "text-[var(--color-credit)]",
    warning: "text-[var(--color-warning)]",
    neutral: "text-[var(--color-text)]",
  }[tone ?? "neutral"];

  return (
    <div className={cn("rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4", className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className={cn("mt-1 font-mono text-2xl font-semibold tabular-nums", toneClass)}>
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</div>
      )}
    </div>
  );
}

export function StatGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {children}
    </div>
  );
}
