import { createHmac } from "node:crypto";

export function deriveMcpRefKey(secret: string | undefined): Buffer {
  if (!secret) throw new Error("MCP is not configured.");
  return createHmac("sha256", secret).update("money:mcp:txn-ref:v1").digest();
}

export function transactionRef(key: Uint8Array, userId: string, transactionId: string): string {
  return `txn_${createHmac("sha256", key).update(`${userId}:${transactionId}`).digest("base64url").slice(0, 22)}`;
}
