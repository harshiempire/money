import { cn } from "@/lib/cn";
import { Card } from "./Card";

export function DataTable({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card padding="none" className={cn("overflow-hidden", className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    </Card>
  );
}

export function DataTableHead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-surface-muted/95 text-left text-[11px] font-medium uppercase tracking-wide text-neutral-500 backdrop-blur-sm">
      {children}
    </thead>
  );
}

export function DataTableRow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <tr
      className={cn(
        "border-t border-border-subtle transition-colors hover:bg-surface-muted/60",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function DataTableCell({
  className,
  children,
  align = "left",
}: {
  className?: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn(
        "px-4 py-2.5",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function DataTableHeaderCell({
  className,
  children,
  align = "left",
}: {
  className?: string;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-4 py-2.5",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}
