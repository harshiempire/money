import { formatPaisePlain, formatPaiseShort } from "@/lib/format";
import type { SplitBridgeTotals } from "@/domain/spend/net";
import type { ReimbursementBridgeTotals } from "@/domain/spend/reimbursements";

const svgCoord = (n: number) => Number(n.toFixed(1));

type WaterfallStep = {
  key: string;
  label: string;
  value: number;
  kind: "anchor" | "delta" | "total";
  tone: "spend" | "inflow" | "owed-to-me" | "neutral";
};

const FILL_CLASS: Record<WaterfallStep["tone"], string> = {
  neutral: "fill-neutral-400/70 dark:fill-neutral-500/70",
  spend: "fill-spend/80",
  inflow: "fill-inflow/80",
  "owed-to-me": "fill-owed-to-me/80",
};

function formatLabel(value: number, compact: boolean): string {
  const fmt = compact ? formatPaiseShort : formatPaisePlain;
  return fmt(value);
}

function formatDeltaLabel(value: number, compact: boolean): string {
  if (value > 0) return `+${formatLabel(value, compact)}`;
  if (value < 0) return `−${formatLabel(Math.abs(value), compact)}`;
  return formatLabel(value, compact);
}

function buildSteps(
  bridge: SplitBridgeTotals,
  netSelfPaise: number,
  owedSelfPaise: number,
): WaterfallStep[] {
  const steps: WaterfallStep[] = [
    {
      key: "gross",
      label: "Gross debits",
      value: bridge.personalDebitGrossPaise,
      kind: "anchor",
      tone: "neutral",
    },
  ];
  if (bridge.othersSharePaise > 0) {
    steps.push({
      key: "others",
      label: "For others",
      value: -bridge.othersSharePaise,
      kind: "delta",
      tone: "inflow",
    });
  }
  steps.push({
    key: "share",
    label: "Your share",
    value: bridge.yourShareDebitPaise,
    kind: "anchor",
    tone: "spend",
  });
  if (owedSelfPaise > 0) {
    steps.push({
      key: "owed",
      label: "Others paid",
      value: owedSelfPaise,
      kind: "delta",
      tone: "owed-to-me",
    });
  }
  if (bridge.netCreditPaise > 0) {
    steps.push({
      key: "refunds",
      label: "Refunds",
      value: -bridge.netCreditPaise,
      kind: "delta",
      tone: "inflow",
    });
  }
  steps.push({
    key: "net",
    label: "Net spend",
    value: netSelfPaise,
    kind: "anchor",
    tone: netSelfPaise >= 0 ? "spend" : "inflow",
  });
  return steps;
}

export function SpendWaterfall({
  bridge,
  netSelfPaise,
  owedSelfPaise = 0,
  reimbursement,
  compact = false,
}: {
  bridge: SplitBridgeTotals;
  netSelfPaise: number;
  owedSelfPaise?: number;
  reimbursement?: ReimbursementBridgeTotals;
  compact?: boolean;
}) {
  if (bridge.personalDebitGrossPaise <= 0 && bridge.netCreditPaise <= 0) {
    return null;
  }

  const W = 800;
  const H = compact ? 180 : 220;
  const PAD_TOP = 18;
  const PAD_BOTTOM = 22;
  const PAD_X = 8;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const maxLevel = Math.max(
    bridge.personalDebitGrossPaise,
    bridge.yourShareDebitPaise + owedSelfPaise,
    Math.abs(netSelfPaise),
    1,
  );
  const scale = innerH / maxLevel;
  const yOf = (level: number) => svgCoord(PAD_TOP + innerH - level * scale);

  const steps = buildSteps(bridge, netSelfPaise, owedSelfPaise);
  const n = steps.length;
  const colW = (W - 2 * PAD_X) / n;
  const barW = colW * 0.6;

  let level = 0;
  const bars: Array<{
    step: WaterfallStep;
    x: number;
    y: number;
    h: number;
    labelY: number;
    levelAfter: number;
    displayValue: string;
    title: string;
  }> = [];
  const connectors: Array<{ x1: number; x2: number; y: number }> = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const cx = PAD_X + i * colW + colW / 2;
    const x = svgCoord(cx - barW / 2);

    let yTop: number;
    let yBottom: number;
    let displayValue: string;
    let title: string;
    let levelAfter: number;

    if (step.kind === "delta") {
      yTop = yOf(level);
      yBottom = yOf(level + step.value);
      levelAfter = level + step.value;
      displayValue = formatDeltaLabel(step.value, compact);
      title = `${step.label} · ${formatPaisePlain(step.value)}`;
    } else {
      const drawValue =
        step.key === "net" && step.value < 0
          ? Math.abs(step.value)
          : step.value;
      yTop = yOf(drawValue);
      yBottom = yOf(0);
      levelAfter = step.value;
      displayValue = formatLabel(
        step.key === "net" && step.value < 0
          ? Math.abs(step.value)
          : step.value,
        compact,
      );
      title =
        step.key === "net" && step.value < 0
          ? `${step.label} · ${formatPaisePlain(Math.abs(step.value))} (net inflow)`
          : `${step.label} · ${formatPaisePlain(step.value)}`;
    }

    const y = Math.min(yTop, yBottom);
    const h = svgCoord(Math.abs(yBottom - yTop));

    bars.push({
      step,
      x,
      y,
      h,
      labelY: y,
      levelAfter,
      displayValue,
      title,
    });

    if (i > 0) {
      const prev = bars[i - 1]!;
      const prevRight = prev.x + barW;
      connectors.push({
        x1: svgCoord(prevRight),
        x2: x,
        y: yOf(level),
      });
    }

    level = levelAfter;
  }

  const netBarIndex = steps.findIndex((s) => s.key === "net");
  const netBar = netBarIndex >= 0 ? bars[netBarIndex] : null;
  const showReimbursementMarker =
    reimbursement != null &&
    reimbursement.outstandingReimbursePaise > 0 &&
    netBar != null;
  const reimbY =
    showReimbursementMarker && netSelfPaise >= 0
      ? yOf(netSelfPaise - reimbursement!.outstandingReimbursePaise)
      : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mb-4 w-full"
      role="img"
      aria-label="Net spend waterfall"
    >
      <line
        x1={PAD_X}
        x2={W - PAD_X}
        y1={yOf(0)}
        y2={yOf(0)}
        stroke="currentColor"
        strokeWidth={0.5}
        className="text-neutral-300 dark:text-neutral-600"
      />

      {connectors.map((c, i) => (
        <line
          key={`conn-${i}`}
          x1={c.x1}
          x2={c.x2}
          y1={c.y}
          y2={c.y}
          strokeDasharray="3 3"
          className="stroke-neutral-400/60"
          strokeWidth={1}
        />
      ))}

      {bars.map((b) => (
        <g key={b.step.key}>
          <rect
            x={b.x}
            y={b.y}
            width={svgCoord(barW)}
            height={b.h}
            className={FILL_CLASS[b.step.tone]}
            rx={1}
          >
            <title>{b.title}</title>
          </rect>
          <text
            x={svgCoord(b.x + barW / 2)}
            y={svgCoord(b.labelY - 4)}
            textAnchor="middle"
            fontSize={10}
            className="fill-neutral-600 dark:fill-neutral-300"
          >
            {b.displayValue}
          </text>
          <text
            x={svgCoord(b.x + barW / 2)}
            y={svgCoord(PAD_TOP + innerH + 14)}
            textAnchor="middle"
            fontSize={9}
            className="fill-neutral-500 dark:fill-neutral-400"
          >
            {b.step.label}
          </text>
        </g>
      ))}

      {showReimbursementMarker && reimbY != null && netBar != null && (
        <line
          x1={netBar.x}
          x2={svgCoord(netBar.x + barW)}
          y1={reimbY}
          y2={reimbY}
          strokeDasharray="4 3"
          className="stroke-owed-to-me/80"
          strokeWidth={1.5}
        >
          <title>{`If everyone pays you back · ${formatPaisePlain(
            netSelfPaise - reimbursement!.outstandingReimbursePaise,
          )}`}</title>
        </line>
      )}
    </svg>
  );
}
