import { formatPaise, formatPaisePlain } from "@/lib/format";

export type MoneyTone =
  | "spend"
  | "inflow"
  | "owed-to-me"
  | "i-owe"
  | "neutral"
  | "muted"
  | "auto";

const TONE_CLASS: Record<Exclude<MoneyTone, "auto">, string> = {
  spend: "text-spend",
  inflow: "text-inflow",
  "owed-to-me": "text-owed-to-me",
  "i-owe": "text-i-owe",
  neutral: "",
  muted: "text-neutral-500",
};

/**
 * Inline paise amount. tone="auto" colors by sign (>= 0 spend, < 0 inflow) —
 * matching the BridgeRow convention. `signed` prefixes − for negatives and
 * renders the absolute value (the app-wide display convention).
 */
export function Money({
  value,
  tone = "neutral",
  signed = false,
  plain = false,
  className = "",
}: {
  value: number | null | undefined;
  tone?: MoneyTone;
  signed?: boolean;
  /** Use formatPaisePlain (deterministic, SSR-safe — required inside SVG). */
  plain?: boolean;
  className?: string;
}) {
  const resolvedTone =
    tone === "auto" ? ((value ?? 0) >= 0 ? "spend" : "inflow") : tone;
  const fmt = plain ? formatPaisePlain : formatPaise;
  const display =
    value == null
      ? fmt(value)
      : signed
        ? `${value < 0 ? "−" : ""}${fmt(Math.abs(value))}`
        : fmt(value);
  return (
    <span
      className={`font-mono whitespace-nowrap ${TONE_CLASS[resolvedTone]} ${className}`.trim()}
    >
      {display}
    </span>
  );
}
