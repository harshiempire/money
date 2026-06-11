export function Bar({
  value,
  max,
  className = "",
}: {
  value: number;
  max: number;
  className?: string;
}) {
  const width = Math.max(2, (value / Math.max(1, max)) * 100).toFixed(1);
  return (
    <div
      className={`h-1.5 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800 ${className}`.trim()}
    >
      <div
        className="h-full bg-red-500/70 dark:bg-red-400/70"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
