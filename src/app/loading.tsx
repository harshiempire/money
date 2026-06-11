import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function DashboardLoading() {
  return (
    <AppShell title="Money">
      <Skeleton className="mt-6 h-8 w-48" />
      <Skeleton className="mt-8 h-12 w-64" />
      <Skeleton className="mt-4 h-4 w-40" />
      <Skeleton className="mt-8 h-40 w-full" />
      <Skeleton className="mt-8 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-3/4" />
    </AppShell>
  );
}
