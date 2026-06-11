import { AppShell } from "@/components/AppShell";
import { Skeleton } from "@/components/ui/Skeleton";

export default function TransactionsLoading() {
  return (
    <AppShell title="Transactions" width="wide">
      <Skeleton className="mt-2 h-4 w-48" />
      <Skeleton className="mt-4 h-10 w-full" />
      <Skeleton className="mt-6 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-full" />
      <Skeleton className="mt-2 h-5 w-5/6" />
    </AppShell>
  );
}
