import { expect, test } from "bun:test";
import { deriveMcpRefKey, shareRef, owedRef, settlementRef, transactionRef } from "./refs";

test("entity refs are deterministic, opaque, domain-separated and bind both account and user", () => {
  const key = deriveMcpRefKey("test-secret");
  const refs = [shareRef, owedRef, settlementRef].map((make, i) => {
    const ref = make(key, "owner", "account", "db-id");
    expect(ref).toMatch(new RegExp(`^${["shr", "owe", "stl"][i]}_[A-Za-z0-9_-]{22}$`));
    expect(make(key, "owner", "account", "db-id")).toBe(ref);
    for (const [user, account, id] of [["other", "account", "db-id"], ["owner", "other", "db-id"], ["owner", "account", "other-id"]]) {
      expect(make(key, user, account, id)).not.toBe(ref);
    }
    expect(make(deriveMcpRefKey("rotated"), "owner", "account", "db-id")).not.toBe(ref);
    expect(ref).not.toContain("db-id");
    // Compare digests, not just the prefixes: domains differ even for identical IDs.
    return ref.slice(4);
  });
  refs.push(transactionRef(key, "owner", "db-id").slice(4));
  expect(new Set(refs).size).toBe(4);
  expect(shareRef(key, "a:b", "c", "d")).not.toBe(shareRef(key, "a", "b:c", "d"));
  expect(() => deriveMcpRefKey(undefined)).toThrow();
});
