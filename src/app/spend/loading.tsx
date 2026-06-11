import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function SpendLoading() {
  return (
    <AppShell title="Spend report">
      <Skeleton className="mt-2 h-4 w-72" />
      <Skeleton className="mt-6 h-8 w-56" />
      <Skeleton className="mt-8 h-12 w-64" />
      <Skeleton className="mt-8 h-48 w-full" />
      <Skeleton className="mt-8 h-32 w-full" />
    </AppShell>
  );
}
