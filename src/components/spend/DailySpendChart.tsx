import { formatPaisePlain } from "@/lib/format";

const svgCoord = (n: number) => Number(n.toFixed(1));

export function DailySpendChart({
  points,
}: {
  points: Array<{ date: string; netSelfPaise: number }>;
}) {
  const W = 800;
  const H = 120;
  const PAD_X = 8;
  const PAD_Y = 8;
  const innerW = W - PAD_X * 2;
  const innerH = H - PAD_Y * 2;

  if (points.length < 2) {
    return (
      <p className="text-sm text-neutral-500">Not enough days for a chart.</p>
    );
  }

  const ys = points.map((p) => Math.max(0, p.netSelfPaise));
  const maxY = Math.max(1, ...ys);
  const barW = innerW / points.length;
  const lastIndex = points.length - 1;
  const ticks = [0, Math.floor(points.length / 2), lastIndex].filter(
    (v, i, a) => a.indexOf(v) === i,
  );

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-28 w-full text-neutral-500"
      preserveAspectRatio="none"
    >
      {points.map((p, i) => {
        const h = p.netSelfPaise > 0 ? (p.netSelfPaise / maxY) * innerH : 0;
        const x = svgCoord(PAD_X + i * barW + barW * 0.15);
        const w = svgCoord(barW * 0.7);
        const y = svgCoord(PAD_Y + innerH - h);
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
          x={svgCoord(PAD_X + i * barW + barW / 2)}
          y={H - 1}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.7}
        >
          {points[i].date.slice(5)}
        </text>
      ))}
    </svg>
  );
}
