"use client";

import { useEffect, useMemo, useState } from "react";
import { formatPaiseWhole } from "@/lib/format";
import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";
import {
  WATERFALL_LABELS,
  buildWaterfallLayout,
  type WaterfallBarSegment,
  type WaterfallLabelStyle,
  type WaterfallRowKey,
  type WaterfallRowModel,
} from "./waterfall-layout";

const LABEL_STORAGE_KEY = "money-waterfall-label-style";

function barClass(variant: WaterfallBarSegment["variant"]): string {
  switch (variant) {
    case "neutral":
      return "bg-waterfall-gross";
    case "inflow":
      return "bg-waterfall-mint";
    case "owed-hatch":
      return "bg-waterfall-hatch";
    case "i-owe":
      return "bg-waterfall-blue";
    case "spend":
      return "bg-waterfall-net";
    default:
      return "bg-waterfall-gross";
  }
}

function formatRowAmount(
  key: WaterfallRowKey,
  amountPaise: number,
  signedDisplay: boolean,
): string {
  if (!signedDisplay) {
    return formatPaiseWhole(key === "net" ? amountPaise : Math.abs(amountPaise));
  }
  if (key === "friends" || key === "credits") {
    return `−${formatPaiseWhole(amountPaise)}`;
  }
  if (key === "owed") {
    return `+${formatPaiseWhole(amountPaise)}`;
  }
  return formatPaiseWhole(amountPaise);
}

function friendsHint(splitCount: number): string {
  if (splitCount <= 0) return "Their part of split bills you paid";
  return `Their part of ${splitCount} split bill${splitCount === 1 ? "" : "s"}`;
}

function WaterfallTrack({ row }: { row: WaterfallRowModel }) {
  const segs = row.bar.filter((seg) => seg.widthPct > 0);
  const isFriendsCapsule =
    row.key === "friends" &&
    segs.length > 0 &&
    segs.every((s) => s.variant === "inflow" || s.variant === "owed-hatch");

  return (
    <div className="relative h-[26px] rounded-[5px] bg-waterfall-track dark:bg-neutral-900">
      {isFriendsCapsule ? (
        <div
          className="absolute top-0 bottom-0 flex overflow-hidden rounded-[5px]"
          style={{
            left: `${segs[0]!.leftPct}%`,
            width: `${segs.reduce((s, seg) => s + seg.widthPct, 0)}%`,
          }}
        >
          {segs.map((seg, i) => (
            <div
              key={i}
              className={`h-full min-w-px ${barClass(seg.variant)}`}
              style={{
                width: `${(seg.widthPct / segs.reduce((s, x) => s + x.widthPct, 0)) * 100}%`,
              }}
            />
          ))}
        </div>
      ) : (
        segs.map((seg, i) => (
          <div
            key={i}
            className={`absolute top-0 bottom-0 min-w-px rounded-[5px] ${barClass(seg.variant)}`}
            style={{
              left: `${seg.leftPct}%`,
              width: `${seg.widthPct}%`,
            }}
          />
        ))
      )}
    </div>
  );
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
  const titleGross = formatPaiseWhole(gross);
  const titleNet = formatPaiseWhole(Math.abs(netSelfPaise));
  const labels = WATERFALL_LABELS[labelStyle];

  const share = bridge.yourShareDebitPaise;
  const mathLine1 = `${formatPaiseWhole(gross)} − ${formatPaiseWhole(bridge.othersSharePaise)} = ${formatPaiseWhole(share)}`;
  const mathLine2 = `${formatPaiseWhole(share)} + ${formatPaiseWhole(owedSelfPaise)} − ${formatPaiseWhole(bridge.netCreditPaise)} = ${formatPaiseWhole(netSelfPaise)}`;

  return (
    <section
      className={`rounded-[14px] border border-[#ecebe8] bg-white px-[clamp(1.125rem,3vw,2rem)] py-7 dark:border-neutral-800 dark:bg-neutral-950 ${className}`.trim()}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[18px] font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
          How {titleGross} became {titleNet}
        </h2>
        <p className="text-sm text-[#6b6964] dark:text-neutral-400">
          Read top to bottom. Each bar starts where the previous one ended.
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-[#6b6964] dark:text-neutral-400">
          <button
            type="button"
            onClick={toggleLabelStyle}
            className="underline underline-offset-2"
          >
            {labelStyle === "plain" ? "Accounting terms" : "Plain words"}
          </button>
          {reportHref ? (
            <a href={reportHref} className="underline-offset-2 hover:underline">
              Full spend report →
            </a>
          ) : null}
        </div>
      </div>

      <div className="mt-[22px] flex flex-col">
        {layout.rows
          .filter((row) => row.show)
          .map((row) => {
            const copy = labels[row.key];
            const hint =
              row.key === "friends"
                ? friendsHint(bridge.splitTxnCount)
                : copy.hint;
            const isNet = row.key === "net";
            const amount = formatRowAmount(
              row.key,
              row.amountPaise,
              row.signedDisplay,
            );
            return (
              <div
                key={row.key}
                className={`grid grid-cols-1 gap-1.5 py-3 sm:grid-cols-[minmax(150px,240px)_minmax(0,1fr)_5.75rem] sm:items-center sm:gap-5 ${
                  isNet
                    ? "mt-1.5 border-t border-[#ecebe8] pt-4 dark:border-neutral-800"
                    : ""
                }`}
              >
                <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:items-stretch sm:justify-start sm:gap-0.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className={`text-[15px] text-neutral-900 dark:text-neutral-100 ${
                        isNet ? "font-semibold" : "font-medium"
                      }`}
                    >
                      {copy.title}
                    </span>
                    <span className="text-[13px] text-[#8a8883] dark:text-neutral-400">
                      {hint}
                    </span>
                  </div>
                  <div
                    className={`shrink-0 font-mono text-sm tabular-nums sm:hidden ${
                      isNet
                        ? "text-[15px] font-semibold text-waterfall-amount"
                        : "text-neutral-900 dark:text-neutral-100"
                    }`}
                  >
                    {amount}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <WaterfallTrack row={row} />
                  {row.legend &&
                    (row.legend.paidBackPaise > 0 ||
                      row.legend.waitingPaise > 0) && (
                      <div className="flex flex-wrap justify-end gap-x-3.5 gap-y-1 text-xs text-[#6b6964] dark:text-neutral-400">
                        {row.legend.paidBackPaise > 0 && (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="size-[9px] rounded-[2px] bg-waterfall-mint"
                              aria-hidden
                            />
                            {formatPaiseWhole(row.legend.paidBackPaise)} paid
                            back
                          </span>
                        )}
                        {row.legend.waitingPaise > 0 && (
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className="size-[9px] rounded-[2px] bg-waterfall-hatch-swatch"
                              aria-hidden
                            />
                            {formatPaiseWhole(row.legend.waitingPaise)} still
                            waiting
                          </span>
                        )}
                      </div>
                    )}
                </div>

                <div
                  className={`hidden text-right font-mono text-sm tabular-nums sm:block ${
                    isNet
                      ? "text-[15px] font-semibold text-waterfall-amount"
                      : row.key === "gross"
                        ? "text-neutral-900 dark:text-neutral-100"
                        : "text-[#6b6964] dark:text-neutral-400"
                  }`}
                >
                  {amount}
                </div>
              </div>
            );
          })}
      </div>

      <div className="mt-5 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setShowMath((v) => !v)}
          className="self-start border-0 bg-transparent p-0 text-[13px] text-[#6b6964] underline underline-offset-[3px] dark:text-neutral-400"
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
                <span className="font-sans font-semibold text-waterfall-amount">
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
