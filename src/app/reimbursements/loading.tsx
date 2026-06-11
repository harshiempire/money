import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function ReimbursementsLoading() {
  return (
    <AppShell title="Reimbursements">
      <Skeleton className="mt-2 h-4 w-full max-w-lg" />
      <Skeleton className="mt-6 h-8 w-48" />
      <Skeleton className="mt-8 h-36 w-full" />
      <Skeleton className="mt-6 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-full" />
    </AppShell>
  );
}
