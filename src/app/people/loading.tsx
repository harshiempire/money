import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function PeopleLoading() {
  return (
    <AppShell title="People">
      <Skeleton className="mt-2 h-4 w-64" />
      <Skeleton className="mt-6 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-3/4" />
    </AppShell>
  );
}
