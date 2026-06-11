import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function TimelineLoading() {
  return (
    <AppShell title="Timeline">
      <Skeleton className="mt-6 h-8 w-56" />
      <Skeleton className="mt-6 h-24 w-full" />
      <Skeleton className="mt-8 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-4/5" />
    </AppShell>
  );
}
