import { cn } from "@/lib/cn";

type MaxWidth = "2xl" | "5xl" | "6xl";

const widthClass: Record<MaxWidth, string> = {
  "2xl": "max-w-2xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
};

export function PageShell({
  title,
  description,
  width = "5xl",
  actions,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  width?: MaxWidth;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <main
      className={cn(
        "mx-auto px-4 py-8 pt-16 md:px-8 md:pt-8",
        widthClass[width],
        className,
      )}
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <div className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>
      {children}
    </main>
  );
}
