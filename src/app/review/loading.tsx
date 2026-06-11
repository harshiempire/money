import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function ReviewLoading() {
  return (
    <AppShell title="Review later" width="wide">
      <Skeleton className="mt-2 h-4 w-full max-w-md" />
      <Skeleton className="mt-6 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-5/6" />
    </AppShell>
  );
}
