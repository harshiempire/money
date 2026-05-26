import { counterpartyLabel } from "@/lib/format";

const normalize = (s: string) => s.trim().toLowerCase();

/** Local part of a UPI handle, e.g. "nitin" from "nitin@okaxis". */
const upiLocalPart = (handle: string): string | null => {
  const at = handle.indexOf("@");
  if (at <= 0) return null;
  return handle.slice(0, at);
};

/**
 * Best-effort match from a bank counterparty to a person name already in
 * `person`. No schema link — purely string/heuristic matching.
 */
export function guessPersonFromCounterparty(input: {
  counterpartyDisplayName: string | null | undefined;
  rawDescription: string;
  knownPersonNames: string[];
}): string | undefined {
  const labels = [
    input.counterpartyDisplayName?.trim(),
    counterpartyLabel(input.rawDescription),
  ].filter((s): s is string => Boolean(s?.trim()));

  if (labels.length === 0 || input.knownPersonNames.length === 0) {
    return undefined;
  }

  const normalizedLabels = labels.map(normalize);
  let best: { name: string; score: number } | undefined;

  for (const personName of input.knownPersonNames) {
    const person = normalize(personName);
    if (!person) continue;

    for (const label of normalizedLabels) {
      let score = 0;
      if (label === person) score = 100;
      else if (label.startsWith(`${person}@`)) score = 90;
      else {
        const local = upiLocalPart(label);
        if (local && local === person) score = 85;
        else if (local && local.startsWith(person) && person.length >= 3) {
          score = 70;
        } else if (label.includes(person) && person.length >= 3) score = 60;
        else if (person.includes(label) && label.length >= 3) score = 50;
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { name: personName, score };
      }
    }
  }

  return best?.name;
}

/** Prefer learned counterparty → person mapping, then name/heuristic match. */
export function resolveDefaultPersonFilter(input: {
  counterpartyId: string | null;
  counterpartyDisplayName: string | null | undefined;
  rawDescription: string;
  knownPersonNames: string[];
  counterpartyPersonHints: Record<string, string>;
}): string {
  if (input.counterpartyId) {
    const hinted = input.counterpartyPersonHints[input.counterpartyId]?.trim();
    if (hinted) {
      const canonical = input.knownPersonNames.find(
        (n) => normalize(n) === normalize(hinted),
      );
      return canonical ?? hinted;
    }
  }

  return (
    guessPersonFromCounterparty({
      counterpartyDisplayName: input.counterpartyDisplayName,
      rawDescription: input.rawDescription,
      knownPersonNames: input.knownPersonNames,
    }) ?? ""
  );
}
