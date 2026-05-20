import { formatPaise, formatPaisePlain } from "@/lib/format";

const svgCoord = (n: number) => Number(n.toFixed(1));

export function DailySpendChart({
  points,
}: {
  points: Array<{ date: string; netSelfPaise: number }>;
}) {
  const W = 800;
  const H = 140;
  const PAD_LEFT = 8;
  const PAD_RIGHT = 8;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 24;

  if (points.length < 2) {
    return (
      <p className="text-sm text-neutral-500">Not enough days for a chart.</p>
    );
  }

  const ys = points.map((p) => Math.max(0, p.netSelfPaise));
  const maxY = Math.max(1, ...ys);
  const totalPaise = points.reduce((sum, p) => sum + Math.max(0, p.netSelfPaise), 0);
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const barW = innerW / points.length;
  const lastIndex = points.length - 1;
  const ticks = [0, Math.floor(points.length / 2), lastIndex].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-neutral-500">
        <span>
          Total{" "}
          <span className="font-mono text-neutral-700 dark:text-neutral-300">
            {formatPaise(totalPaise)}
          </span>
        </span>
        <span>
          Peak day{" "}
          <span className="font-mono text-neutral-700 dark:text-neutral-300">
            {formatPaise(maxY)}
          </span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full text-neutral-500"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Daily net spend bar chart"
      >
        <line
          x1={PAD_LEFT}
          x2={W - PAD_RIGHT}
          y1={PAD_TOP + innerH}
          y2={PAD_TOP + innerH}
          stroke="currentColor"
          strokeWidth={0.5}
          opacity={0.35}
        />
        {points.map((p, i) => {
          const h = p.netSelfPaise > 0 ? (p.netSelfPaise / maxY) * innerH : 0;
          const x = svgCoord(PAD_LEFT + i * barW + barW * 0.15);
          const w = svgCoord(barW * 0.7);
          const y = svgCoord(PAD_TOP + innerH - h);
          return (
            <rect
              key={p.date}
              x={x}
              y={y}
              width={w}
              height={svgCoord(Math.max(0, h))}
              className="fill-red-500/60 dark:fill-red-400/60"
              rx={1}
            >
              <title>{`${p.date} · ${formatPaisePlain(p.netSelfPaise)}`}</title>
            </rect>
          );
        })}
        {ticks.map((i) => (
          <text
            key={points[i].date}
            x={svgCoord(PAD_LEFT + i * barW + barW / 2)}
            y={H - 6}
            textAnchor="middle"
            fontSize={9}
            className="fill-neutral-600 dark:fill-neutral-300"
          >
            {points[i].date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}
