import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { loadSecretKey, open, seal } from "./secret-box";

const key = randomBytes(32);

describe("secret-box", () => {
  test("round-trips", () => {
    const sealed = seal("refresh-token-value", "user-1:chatgpt", key);
    expect(sealed).not.toContain("refresh-token-value");
    expect(open(sealed, "user-1:chatgpt", key)).toBe("refresh-token-value");
  });

  test("fresh IV every time", () => {
    expect(seal("x", "c", key)).not.toBe(seal("x", "c", key));
  });

  test("a ciphertext moved to another user's row won't open", () => {
    const sealed = seal("secret", "user-1:chatgpt", key);
    expect(() => open(sealed, "user-2:chatgpt", key)).toThrow();
  });

  test("tampering and wrong keys are detected", () => {
    const sealed = seal("secret", "c", key);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => open(parts.join("."), "c", key)).toThrow();
    expect(() => open(sealed, "c", randomBytes(32))).toThrow();
  });

  test("rejects missing or short keys", () => {
    expect(() => loadSecretKey("")).toThrow();
    expect(() => loadSecretKey(randomBytes(16).toString("base64"))).toThrow();
    expect(loadSecretKey(key.toString("base64")).equals(key)).toBe(true);
  });
});
