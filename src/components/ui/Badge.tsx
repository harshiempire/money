import { cn } from "@/lib/cn";

type Tone = "neutral" | "debit" | "credit" | "warning" | "info" | "violet";

const tones: Record<Tone, string> = {
  neutral: "bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)]",
  debit: "bg-[var(--color-debit-muted)] text-[var(--color-debit)]",
  credit: "bg-[var(--color-credit-muted)] text-[var(--color-credit)]",
  warning: "bg-[var(--color-warning-muted)] text-[var(--color-warning)]",
  info: "bg-[var(--color-info-muted)] text-[var(--color-info)]",
  violet: "bg-[var(--color-violet-muted)] text-[var(--color-violet)]",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
