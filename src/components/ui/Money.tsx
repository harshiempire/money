import { formatPaise } from "@/lib/format";

export type MoneyTone =
  | "spend"
  | "inflow"
  | "owed-to-me"
  | "i-owe"
  | "neutral"
  | "muted";

const TONE_CLASS: Record<MoneyTone, string> = {
  spend: "text-spend",
  inflow: "text-inflow",
  "owed-to-me": "text-owed-to-me",
  "i-owe": "text-i-owe",
  neutral: "",
  muted: "text-neutral-500",
};

export function Money({
  value,
  tone = "neutral",
  signed = false,
  className = "",
}: {
  value: number | null | undefined;
  tone?: MoneyTone;
  signed?: boolean;
  className?: string;
}) {
  const display =
    value == null
      ? formatPaise(value)
      : signed
        ? `${value < 0 ? "−" : ""}${formatPaise(Math.abs(value))}`
        : formatPaise(value);
  return (
    <span
      className={`font-mono whitespace-nowrap ${TONE_CLASS[tone]} ${className}`.trim()}
    >
      {display}
    </span>
  );
}
