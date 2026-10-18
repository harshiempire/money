import { createHash, randomBytes } from "node:crypto";
import { Schema } from "effect";

export const McpScope = Schema.Literals(["read", "propose"]);
export type McpScope = typeof McpScope.Type;
export const McpToken = Schema.String.check(Schema.isPattern(/^mny_[A-Za-z0-9_-]{43}$/));

export function generateMcpToken(): string {
  return `mny_${randomBytes(32).toString("base64url")}`;
}

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseMcpBearer(header: string | null): string | null {
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  return match && Schema.is(McpToken)(match[1]) ? match[1] : null;
}
