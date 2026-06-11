import type { ReactNode } from "react";

/**
 * The bordered rounded card used throughout the app. Optional title + action
 * row sits above the content; pass layout margins (e.g. `mt-8`) via className.
 */
export function SectionCard({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const hasHeader = title != null || action != null;
  return (
    <section
      className={`rounded border border-neutral-200 p-4 dark:border-neutral-800 ${className}`.trim()}
    >
      {hasHeader && (
        <div className="flex items-baseline justify-between gap-3">
          {title != null ? (
            <h2 className="text-sm font-semibold">{title}</h2>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      <div className={hasHeader ? "mt-3" : ""}>{children}</div>
    </section>
  );
}
