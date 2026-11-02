import { createHmac } from "node:crypto";

export function deriveMcpRefKey(secret: string | undefined): Buffer {
  if (!secret) throw new Error("MCP is not configured.");
  return createHmac("sha256", secret).update("money:mcp:txn-ref:v1").digest();
}

export function transactionRef(key: Uint8Array, userId: string, transactionId: string): string {
  return `txn_${createHmac("sha256", key).update(`${userId}:${transactionId}`).digest("base64url").slice(0, 22)}`;
}

export function deriveMcpRevKey(secret: string | undefined): Buffer {
  if (!secret) throw new Error("MCP is not configured.");
  return createHmac("sha256", secret).update("money:mcp:txn-rev:v1").digest();
}
export function transactionRev(key: Uint8Array, userId: string, transactionId: string, fields: {
  categoryId: string | null; note: string | null; isTransfer: boolean; needsReview: boolean;
}): string {
  // Length-delimited JSON avoids collisions between notes and ids containing separators.
  return `rev_${createHmac("sha256", key).update(JSON.stringify([
    userId, transactionId, fields.categoryId, fields.note, fields.isTransfer, fields.needsReview,
  ])).digest("base64url").slice(0, 12)}`;
}

/** Entity refs bind the user AND selected account; JSON domain separation prevents ambiguity. */
function entityRef(prefix: "shr" | "owe" | "stl" | "nte", key: Uint8Array, userId: string, accountId: string, id: string): string {
  return `${prefix}_${createHmac("sha256", key)
    .update(JSON.stringify([`money:mcp:${prefix}:v1`, userId, accountId, id]))
    .digest("base64url").slice(0, 22)}`;
}
export const shareRef = (key: Uint8Array, userId: string, accountId: string, id: string) => entityRef("shr", key, userId, accountId, id);
export const owedRef = (key: Uint8Array, userId: string, accountId: string, id: string) => entityRef("owe", key, userId, accountId, id);
export const settlementRef = (key: Uint8Array, userId: string, accountId: string, id: string) => entityRef("stl", key, userId, accountId, id);
export const noteRef = (key: Uint8Array, userId: string, accountId: string, id: string) => entityRef("nte", key, userId, accountId, id);

/** Split structure revision, separate from editable transaction fields and settlements. */
export function splitRev(key: Uint8Array, userId: string, transactionId: string, split: {
  id: string; totalPaise: number; yourSharePaise: number;
} | null | undefined, participants: readonly {
  id: string; personName: string; expectedAmountPaise: number;
}[]): string {
  if (!split) return "none";
  const shares = participants.map(p => [p.id, p.personName, p.expectedAmountPaise] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return `spr_${createHmac("sha256", key).update(JSON.stringify([
    "money:mcp:split-rev:v1", userId, transactionId, split.id, split.totalPaise, split.yourSharePaise, shares,
  ])).digest("base64url").slice(0, 22)}`;
}
