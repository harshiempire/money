/** Deep-link to a transaction — loads the statement period that contains it. */
export function transactionHref(transactionId: string): string {
  const q = new URLSearchParams({ txn: transactionId });
  return `/transactions?${q.toString()}#txn-${transactionId}`;
}
