import { formatPaise } from "@/lib/format";

export function StatHero({
  label,
  valuePaise,
  tone,
  suffix,
  children,
}: {
  label: React.ReactNode;
  valuePaise: number;
  /** Resolved by caller; dashboards use netSelfPaise >= 0 ? "spend" : "inflow". */
  tone: "spend" | "inflow";
  /** e.g. the "(net inflow)" tag on the dashboard. */
  suffix?: React.ReactNode;
  /** Meta row below the number (delta, burn rate, counts, links). */
  children?: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-5xl ${tone === "spend" ? "text-spend" : "text-inflow"}`}
      >
        {formatPaise(Math.abs(valuePaise))}
        {suffix}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
        {children}
      </div>
    </section>
  );
}
