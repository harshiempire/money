import { cn } from "@/lib/cn";
import { Card } from "./Card";

type StatTone = "default" | "debit" | "credit" | "receivable" | "payable";

const toneClass: Record<StatTone, string> = {
  default: "text-neutral-900 dark:text-neutral-100",
  debit: "text-debit",
  credit: "text-credit",
  receivable: "text-receivable",
  payable: "text-payable",
};

export function Stat({
  label,
  value,
  hint,
  tone = "default",
  sub,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: StatTone;
  sub?: string;
}) {
  return (
    <Card padding="sm" className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={cn("mt-1 font-mono text-lg", toneClass[tone])}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-[10px] text-neutral-500">{sub}</div>
      )}
      {hint && (
        <div className="mt-1 text-[10px] leading-snug text-neutral-500">
          {hint}
        </div>
      )}
    </Card>
  );
}
