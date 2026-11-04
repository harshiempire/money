/** Only newly encountered rows may be automatically selected, even after removal/rearrival. */
export function appendPreselectedRows<Row extends { txnId: string }>(
  rows: readonly Row[],
  seen: Set<string>,
  selected: Set<string>,
  preselected: (row: Row) => boolean,
): { seen: Set<string>; selected: Set<string> } {
  const fresh = rows.filter((row) => !seen.has(row.txnId));
  if (fresh.length === 0) return { seen, selected };
  const add = fresh.filter(preselected).map((row) => row.txnId);
  return {
    seen: new Set([...seen, ...fresh.map((row) => row.txnId)]),
    selected: add.length > 0 ? new Set([...selected, ...add]) : selected,
  };
}
