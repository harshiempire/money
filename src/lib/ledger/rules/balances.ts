/** Pure exact-paise rules. null refuses invalid inputs or unsafe aggregate amounts. */
export function sumPaise(values: readonly number[]): number | null {
  let total = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    total += BigInt(value);
  }
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}
export function outstandingPaise(expected: number, settledRows: readonly { amountPaise: number }[]): number | null {
  const settled = sumPaise(settledRows.map(r => r.amountPaise));
  return !Number.isSafeInteger(expected) || expected < 0 || settled === null ? null : Math.max(0, expected - settled);
}
/** Missing IDs resolve only against a unique saved person after trimming/case folding.
 * No match or multiple saved matches keep the name key; existing IDs always win.
 */
export function personBalanceKey(
  personId: string | null | undefined,
  name: string,
  people: readonly { id?: string; name: string }[] = [],
): string {
  if (personId) return `id:${personId}`;
  const folded = name.trim().toLowerCase();
  const matches = people.filter(p => p.id && p.name.trim().toLowerCase() === folded);
  return matches.length === 1 ? `id:${matches[0].id}` : `name:${folded}`;
}
export interface BalanceLine {
  id: string; personId?: string | null; personName: string; date: string; what: string;
  amountPaise: number; settledRows: readonly { amountPaise: number }[];
  txnId?: string; order?: string;
}
export interface BalanceRows { people: readonly { id?: string; name: string }[]; shares: readonly BalanceLine[]; owed: readonly BalanceLine[] }
export type OpenBalanceLine = BalanceLine & { settledPaise: number; leftPaise: number };
export interface PersonBalance {
  key: string; personId: string | null; name: string; owedToYouPaise: number; youOwePaise: number; netPaise: number;
  shares: OpenBalanceLine[]; owed: OpenBalanceLine[]; openShareCount: number; openOwedCount: number;
}
/** IDs never merge by spelling. Missing/empty IDs resolve to a saved person only
 * when exactly one saved person matches the trimmed lowercase name. No match or
 * several matches keep a separate name group rather than guessing.
 * Saved person names win; historical-only groups use latest date/order, then lexical spelling.
 */
export function buildPersonBalances(rows: BalanceRows): PersonBalance[] | null {
  const groups = new Map<string, PersonBalance>();
  const saved = new Map(rows.people.map(p => [personBalanceKey(p.id,p.name), p.name.trim()]));
  const entry = (id: string | null | undefined, name: string) => {
    const key = personBalanceKey(id, name, rows.people);
    let p = groups.get(key);
    if (!p) { p = { key, personId: key.startsWith("id:") ? key.slice(3) : null, name: saved.get(key) ?? name.trim(), owedToYouPaise: 0, youOwePaise: 0, netPaise: 0, shares: [], owed: [], openShareCount: 0, openOwedCount: 0 }; groups.set(key, p); }
    return p;
  };
  for (const p of rows.people) entry(p.id, p.name);
  const ordered = [...rows.shares.map(line => ({ line, kind: 'shares' as const })), ...rows.owed.map(line => ({ line, kind: 'owed' as const }))]
    .sort((a,b) => a.line.date.localeCompare(b.line.date) || (a.line.order ?? '').localeCompare(b.line.order ?? '') || a.line.personName.localeCompare(b.line.personName) || a.line.id.localeCompare(b.line.id));
  for (const {line, kind} of ordered) {
    const left = outstandingPaise(line.amountPaise, line.settledRows);
    const paid = sumPaise(line.settledRows.map(r => r.amountPaise));
    if (left === null || paid === null) return null;
    const p = entry(line.personId, line.personName);
    if (!saved.has(p.key)) p.name = line.personName.trim();
    if (left > 0) p[kind].push({ ...line, settledPaise: paid, leftPaise: left });
  }
  for (const p of groups.values()) {
    const recv = sumPaise(p.shares.map(s => s.leftPaise)), pay = sumPaise(p.owed.map(s => s.leftPaise));
    if (recv === null || pay === null) return null;
    p.owedToYouPaise = recv; p.youOwePaise = pay; p.netPaise = recv - pay;
    p.openShareCount = p.shares.length; p.openOwedCount = p.owed.length;
  }
  return [...groups.values()].sort((a,b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
