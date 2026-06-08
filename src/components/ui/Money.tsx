import { cn } from "@/lib/cn";
import { formatPaise } from "@/lib/format";

export function Money({
  paise,
  signed = false,
  size = "md",
  className,
}: {
  paise: number;
  signed?: boolean;
  size?: "sm" | "md" | "lg" | "hero";
  className?: string;
}) {
  const isNegative = paise < 0;
  const isPositive = paise > 0;
  const abs = Math.abs(paise);

  const sizeClass = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-2xl",
    hero: "text-5xl font-semibold",
  }[size];

  const toneClass =
    signed || size === "hero"
      ? isNegative
        ? "text-[var(--color-credit)]"
        : isPositive
          ? "text-[var(--color-debit)]"
          : "text-[var(--color-text)]"
      : "text-[var(--color-text)]";

  const prefix = signed && isNegative ? "−" : signed && isPositive ? "+" : "";

  return (
    <span className={cn("font-mono tabular-nums", sizeClass, toneClass, className)}>
      {prefix}
      {formatPaise(abs)}
    </span>
  );
}
