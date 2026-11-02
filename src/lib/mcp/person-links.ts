import { personKey } from "./person-names";

export const handleStem = (key: string) => key.trim().toLowerCase().split("@")[0].replace(/-\d+$/, "");
type Payee = { key: string; person?: string | null };
type Seen = { key: string; count: number };
/** Suggestions never participate in matching or balances until confirmed. */
export function suggestPersonPayees(name: string, payees: readonly Payee[], seen: readonly Seen[]) {
  const anchors = [...payees.filter(p => p.person && personKey(p.person) === personKey(name)).map(p => p.key), ...seen.map(h => h.key)];
  const stems = new Set(anchors.map(handleStem).filter(s => s.length >= 4));
  const tokens = personKey(name).split(/[^\p{L}]+/u).filter(t => t.length >= 4);
  return payees.filter(p => !p.person).flatMap(p => {
    const count = seen.find(h => h.key === p.key)?.count ?? 0;
    if (count) return [{ key: p.key, reason: `settled this person's shares ${count} times` }];
    const stem = handleStem(p.key);
    if (stems.has(stem) || tokens.some(t => stem.includes(t)))
      return [{ key: p.key, reason: "handle looks like this person's other handles" }];
    return [];
  }).sort((a, b) => a.key.localeCompare(b.key));
}
