import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white hover:opacity-90 dark:bg-neutral-100 dark:text-neutral-900",
  secondary:
    "border border-border-default bg-surface-raised text-neutral-800 hover:bg-surface-muted dark:text-neutral-200",
  ghost:
    "text-neutral-600 hover:bg-surface-muted dark:text-neutral-400",
  danger:
    "border border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/30",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Button({
  variant = "secondary",
  size = "sm",
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium disabled:opacity-50",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export const buttonLinkClass = (active = false) =>
  cn(
    "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium",
    active
      ? "border-accent bg-surface-muted text-neutral-900 dark:text-neutral-100"
      : "border-border-default bg-surface-raised text-neutral-600 hover:bg-surface-muted dark:text-neutral-400",
  );
