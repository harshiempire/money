import { cn } from "@/lib/cn";
import { IconAlert } from "@/components/icons";

type Variant = "warning" | "info" | "success" | "error";

const variants: Record<Variant, { container: string; title: string; text: string }> = {
  warning: {
    container: "border-[var(--color-warning)]/30 bg-[var(--color-warning-muted)]",
    title: "text-[var(--color-warning)]",
    text: "text-[var(--color-text-secondary)]",
  },
  info: {
    container: "border-[var(--color-info)]/30 bg-[var(--color-info-muted)]",
    title: "text-[var(--color-info)]",
    text: "text-[var(--color-text-secondary)]",
  },
  success: {
    container: "border-[var(--color-credit)]/30 bg-[var(--color-credit-muted)]",
    title: "text-[var(--color-credit)]",
    text: "text-[var(--color-text-secondary)]",
  },
  error: {
    container: "border-[var(--color-debit)]/30 bg-[var(--color-debit-muted)]",
    title: "text-[var(--color-debit)]",
    text: "text-[var(--color-text-secondary)]",
  },
};

export function Alert({
  variant = "warning",
  title,
  children,
  className,
}: {
  variant?: Variant;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  const v = variants[variant];
  return (
    <div
      className={cn(
        "flex gap-3 rounded-[var(--radius-lg)] border p-4",
        v.container,
        className,
      )}
    >
      <IconAlert className={cn("mt-0.5 shrink-0", v.title)} />
      <div>
        <h3 className={cn("text-sm font-semibold", v.title)}>{title}</h3>
        <div className={cn("mt-1 text-sm", v.text)}>{children}</div>
      </div>
    </div>
  );
}
