/**
 * AES-256-GCM for secrets stored in Postgres (ChatGPT tokens). The key lives
 * only in the environment; a DB dump alone reveals nothing.
 *
 * `context` is bound as additional authenticated data — pass the row's owner
 * (e.g. `${userId}:chatgpt`) so a ciphertext copied onto another user's row
 * fails to decrypt instead of quietly working.
 *
 * No `server-only` — scripts/connect-chatgpt.ts encrypts with it too.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function loadSecretKey(
  raw: string | undefined = process.env.AI_TOKEN_ENCRYPTION_KEY,
): Buffer {
  if (!raw) throw new Error("AI_TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("AI_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  }
  return key;
}

export function seal(plaintext: string, context: string, key: Buffer = loadSecretKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function open(sealed: string, context: string, key: Buffer = loadSecretKey()): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error("Unrecognised sealed secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
