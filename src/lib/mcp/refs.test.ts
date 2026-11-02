import { expect, test } from "bun:test";
import { deriveMcpRefKey, shareRef, owedRef, settlementRef, transactionRef, deriveMcpRevKey, splitRev } from "./refs";

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


test("split revisions are opaque, sorted, tenant-bound and cover each structural field", () => {
  const key = deriveMcpRevKey("test-secret");
  const split = { id: "split", totalPaise: 30000, yourSharePaise: 10000 };
  const shares = [{ id: "b", personName: "Kiran", expectedAmountPaise: 9000 }, { id: "a", personName: "Ravi Teja", expectedAmountPaise: 11000 }];
  const rev = splitRev(key, "owner", "bill", split, shares);
  expect(rev).toMatch(/^spr_[A-Za-z0-9_-]{22}$/);
  expect(rev).not.toContain("Kiran");
  expect(splitRev(key, "owner", "bill", split, [...shares].reverse())).toBe(rev);
  expect(splitRev(key, "owner", "bill", null, [])).toBe("none");
  for (const next of [{ ...split, id: "other" }, { ...split, totalPaise: 30001 }, { ...split, yourSharePaise: 9999 }])
    expect(splitRev(key, "owner", "bill", next, shares)).not.toBe(rev);
  for (const next of [{ ...shares[0], id: "other" }, { ...shares[0], personName: "Arjun" }, { ...shares[0], expectedAmountPaise: 8999 }])
    expect(splitRev(key, "owner", "bill", split, [next, shares[1]])).not.toBe(rev);
  expect(splitRev(key, "owner", "bill", split, shares.slice(1))).not.toBe(rev);
  expect(splitRev(key, "other", "bill", split, shares)).not.toBe(rev);
  expect(splitRev(key, "owner", "other", split, shares)).not.toBe(rev);
  expect(splitRev(deriveMcpRevKey("rotated"), "owner", "bill", split, shares)).not.toBe(rev);
});
