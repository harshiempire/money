export function transactionHref(transactionId: string): string {
  const q = new URLSearchParams({ txn: transactionId });
  return `/transactions?${q.toString()}#txn-${transactionId}`;
}
