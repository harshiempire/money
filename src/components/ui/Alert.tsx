import { cn } from "@/lib/cn";

type AlertVariant = "warning" | "error" | "info" | "success";

const variantStyles: Record<
  AlertVariant,
  { border: string; bg: string; text: string; accent: string }
> = {
  warning: {
    border: "border-amber-200 dark:border-amber-900/50",
    bg: "bg-amber-50/80 dark:bg-amber-950/25",
    text: "text-amber-900 dark:text-amber-200",
    accent: "bg-amber-500",
  },
  error: {
    border: "border-red-200 dark:border-red-900/50",
    bg: "bg-red-50/80 dark:bg-red-950/25",
    text: "text-red-900 dark:text-red-200",
    accent: "bg-red-500",
  },
  info: {
    border: "border-sky-200 dark:border-sky-900/50",
    bg: "bg-sky-50/80 dark:bg-sky-950/25",
    text: "text-sky-900 dark:text-sky-200",
    accent: "bg-sky-500",
  },
  success: {
    border: "border-emerald-200 dark:border-emerald-900/50",
    bg: "bg-emerald-50/80 dark:bg-emerald-950/25",
    text: "text-emerald-900 dark:text-emerald-200",
    accent: "bg-emerald-500",
  },
};

export function Alert({
  variant = "warning",
  title,
  className,
  children,
}: {
  variant?: AlertVariant;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const v = variantStyles[variant];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg border pl-4 pr-4 py-3 text-sm",
        v.border,
        v.bg,
        v.text,
        className,
      )}
    >
      <div
        className={cn("absolute inset-y-0 left-0 w-1", v.accent)}
        aria-hidden
      />
      {title && <h3 className="font-medium">{title}</h3>}
      <div className={title ? "mt-1.5" : undefined}>{children}</div>
    </div>
  );
}
