"use client";

import { useEffect, useMemo, useState } from "react";
import { formatPaise, formatPaisePlain } from "@/lib/format";
import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";
import {
  WATERFALL_LABELS,
  buildWaterfallLayout,
  type WaterfallBarSegment,
  type WaterfallLabelStyle,
  type WaterfallRowKey,
} from "./waterfall-layout";

const LABEL_STORAGE_KEY = "money-waterfall-label-style";

function barClass(variant: WaterfallBarSegment["variant"]): string {
  switch (variant) {
    case "neutral":
      return "bg-neutral-400/80 dark:bg-neutral-500/80";
    case "inflow":
      return "bg-inflow/75";
    case "owed-hatch":
      return "bg-waterfall-hatch";
    case "i-owe":
      return "bg-i-owe/75";
    case "spend":
      return "bg-spend/80";
    default:
      return "bg-neutral-400";
  }
}

function formatRowAmount(
  key: WaterfallRowKey,
  amountPaise: number,
  signedDisplay: boolean,
): string {
  if (!signedDisplay) {
    return formatPaise(key === "net" ? amountPaise : Math.abs(amountPaise));
  }
  if (key === "friends" || key === "credits") {
    return `−${formatPaise(amountPaise)}`;
  }
  if (key === "owed") {
    return `+${formatPaise(amountPaise)}`;
  }
  return formatPaise(amountPaise);
}

function friendsHint(splitCount: number): string {
  if (splitCount <= 0) return "Their part of split bills you paid";
  return `Their part of ${splitCount} split bill${splitCount === 1 ? "" : "s"}`;
}

export function SpendWaterfall({
  bridge,
  netSelfPaise,
  owedSelfPaise = 0,
  reimbursement,
  reportHref,
  className = "",
}: {
  bridge: SplitBridgeTotals;
  netSelfPaise: number;
  owedSelfPaise?: number;
  reimbursement?: ReimbursementBridgeTotals;
  reportHref?: string;
  className?: string;
}) {
  const layout = useMemo(
    () =>
      buildWaterfallLayout({
        bridge,
        netSelfPaise,
        owedSelfPaise,
        reimbursement,
      }),
    [bridge, netSelfPaise, owedSelfPaise, reimbursement],
  );

  const [showMath, setShowMath] = useState(false);
  const [labelStyle, setLabelStyle] = useState<WaterfallLabelStyle>("plain");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LABEL_STORAGE_KEY);
      if (stored === "plain" || stored === "accounting") {
        setLabelStyle(stored);
      }
    } catch {
      /* private mode */
    }
  }, []);

  const toggleLabelStyle = () => {
    const next = labelStyle === "plain" ? "accounting" : "plain";
    setLabelStyle(next);
    try {
      localStorage.setItem(LABEL_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  if (!layout) return null;

  const gross = bridge.personalDebitGrossPaise;
  const titleGross = formatPaise(gross);
  const titleNet = formatPaise(Math.abs(netSelfPaise));
  const labels = WATERFALL_LABELS[labelStyle];

  const share = bridge.yourShareDebitPaise;
  const mathLine1 = `${formatPaisePlain(gross)} − ${formatPaisePlain(bridge.othersSharePaise)} = ${formatPaisePlain(share)}`;
  const mathLine2 = `${formatPaisePlain(share)} + ${formatPaisePlain(owedSelfPaise)} − ${formatPaisePlain(bridge.netCreditPaise)} = ${formatPaisePlain(netSelfPaise)}`;

  return (
    <section
      className={`rounded-[14px] border border-neutral-200 bg-white px-[clamp(1.125rem,3vw,2rem)] py-7 dark:border-neutral-800 dark:bg-neutral-950 ${className}`.trim()}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            How {titleGross} became {titleNet}
          </h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Read top to bottom. Each bar starts where the previous one ended.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
          <button
            type="button"
            onClick={toggleLabelStyle}
            className="underline-offset-2 hover:underline"
          >
            {labelStyle === "plain" ? "Accounting terms" : "Plain words"}
          </button>
          {reportHref ? (
            <a
              href={reportHref}
              className="text-neutral-500 underline-offset-2 hover:underline"
            >
              Full spend report →
            </a>
          ) : null}
        </div>
      </div>

      <div className="mt-6 flex flex-col">
        {layout.rows
          .filter((row) => row.show)
          .map((row) => {
            const copy = labels[row.key];
            const hint =
              row.key === "friends"
                ? friendsHint(bridge.splitTxnCount)
                : copy.hint;
            const isNet = row.key === "net";
            return (
              <div
                key={row.key}
                className={`grid grid-cols-[minmax(150px,240px)_minmax(0,1fr)_5.75rem] items-center gap-5 py-3 ${
                  isNet
                    ? "mt-1.5 border-t border-neutral-200 pt-4 dark:border-neutral-800"
                    : ""
                }`}
              >
                <div className="flex flex-col gap-0.5">
                  <span
                    className={`text-[15px] ${isNet ? "font-semibold" : "font-medium"} text-neutral-900 dark:text-neutral-100`}
                  >
                    {copy.title}
                  </span>
                  <span className="text-[13px] text-neutral-500 dark:text-neutral-400">
                    {hint}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="relative h-[26px] rounded-[5px] bg-neutral-100 dark:bg-neutral-900">
                    {row.bar
                      .filter((seg) => seg.widthPct > 0)
                      .map((seg, i) => (
                        <div
                          key={i}
                          className={`absolute top-0 bottom-0 min-w-1 rounded-[5px] ${barClass(seg.variant)}`}
                          style={{
                            left: `${seg.leftPct}%`,
                            width: `${seg.widthPct}%`,
                          }}
                        />
                      ))}
                  </div>
                  {row.legend &&
                    (row.legend.paidBackPaise > 0 ||
                      row.legend.waitingPaise > 0) && (
                      <div className="flex flex-wrap justify-end gap-x-3.5 gap-y-1 text-xs text-neutral-500">
                        {row.legend.paidBackPaise > 0 && (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="size-2 rounded-sm bg-inflow/75"
                              aria-hidden
                            />
                            {formatPaise(row.legend.paidBackPaise)} paid back
                          </span>
                        )}
                        {row.legend.waitingPaise > 0 && (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="size-2 rounded-sm bg-waterfall-hatch"
                              aria-hidden
                            />
                            {formatPaise(row.legend.waitingPaise)} still waiting
                          </span>
                        )}
                      </div>
                    )}
                </div>

                <div
                  className={`text-right font-mono text-sm tabular-nums ${
                    isNet
                      ? "text-[15px] font-semibold text-spend"
                      : row.key === "gross"
                        ? "text-neutral-900 dark:text-neutral-100"
                        : "text-neutral-500 dark:text-neutral-400"
                  }`}
                >
                  {formatRowAmount(row.key, row.amountPaise, row.signedDisplay)}
                </div>
              </div>
            );
          })}
      </div>

      <div className="mt-5 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setShowMath((v) => !v)}
          className="self-start border-0 bg-transparent p-0 text-[13px] text-neutral-500 underline-offset-[3px] hover:underline"
        >
          {showMath ? "Hide the math" : "Show the math"}
        </button>
        {showMath && (
          <div className="rounded-[10px] bg-neutral-100 px-[18px] py-4 dark:bg-neutral-900">
            <div className="flex flex-col gap-2 font-mono text-[13px] text-neutral-800 dark:text-neutral-200">
              <div>
                {mathLine1}{" "}
                <span className="font-sans text-neutral-500">
                  your share of what you paid
                </span>
              </div>
              <div>
                {mathLine2}{" "}
                <span className="font-sans font-semibold text-spend">
                  really yours
                </span>
              </div>
              <p className="mt-1 font-sans text-[13px] text-pretty text-neutral-500">
                Money friends pay back is{" "}
                <span className="font-medium text-neutral-700 dark:text-neutral-300">
                  not
                </span>{" "}
                subtracted again. Their part was already taken out in step 2.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
