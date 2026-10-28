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
