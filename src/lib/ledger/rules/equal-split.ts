/**
 * The one equal split, used by the split dialog, Ask Money's cards and agents.
 * Plain integer paise, so it runs in the browser and on the server. Everyone
 * gets the rounded-down share and leftover paise go to you, so participants
 * owe round-ish amounts and the parts always add back to the total.
 */
export function equalShares(totalPaise: number, people: number): { yours: number; each: number } {
  const each = Math.floor(totalPaise / (people + 1));
  return { yours: totalPaise - each * people, each };
}
