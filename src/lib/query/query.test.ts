import { describe, expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { createSessionQueryClient } from "./client";
import { moneyKeys } from "./keys";

describe("tenant read cache", () => {
  test("keys isolate users, transactions, categories and periods", () => {
    const keys = [
      moneyKeys.preview("alice", "txn-a"), moneyKeys.preview("bob", "txn-a"),
      moneyKeys.preview("alice", "txn-b"), moneyKeys.candidate("alice", "txn-a"),
      moneyKeys.category("alice", null, null, null),
      moneyKeys.category("alice", "food", null, null),
      moneyKeys.category("alice", "food", "2026-06-01", null),
      moneyKeys.category("alice", "food", null, "2026-06-30"),
    ];
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
  });

  test("closed reads do not run; repeated opens reuse fresh data; writes invalidate only this tenant", async () => {
    const client = createSessionQueryClient();
    let calls = 0;
    const options = {
      queryKey: moneyKeys.candidate("alice", "txn-a"),
      queryFn: async () => [{ currentNote: `Made-up note ${++calls}` }],
    };
    const observer = new QueryObserver(client, { ...options, enabled: false });
    const unsubscribe = observer.subscribe(() => {});
    expect(calls).toBe(0);
    await client.fetchQuery(options);
    await client.fetchQuery(options);
    expect(calls).toBe(1);
    client.setQueryData(moneyKeys.candidate("bob", "txn-a"), []);
    await client.invalidateQueries({ queryKey: moneyKeys.all("alice") });
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(moneyKeys.candidate("bob", "txn-a"))?.isInvalidated).toBe(false);
    await client.fetchQuery(options);
    expect(calls).toBe(2);
    unsubscribe();
    client.clear();
  });

  test("session clients are independent and clearing prevents late responses from repopulating", async () => {
    const previous = createSessionQueryClient();
    const next = createSessionQueryClient();
    expect(next).not.toBe(previous);
    const key = moneyKeys.preview("alice", "txn-a");
    previous.setQueryData(moneyKeys.candidate("alice", "txn-a"), []);
    let resolve!: (value: string) => void;
    const pending = previous.fetchQuery({ queryKey: key, queryFn: () => new Promise<string>((r) => { resolve = r; }) });
    const settled = pending.catch(() => undefined);
    previous.clear(); // The keyed provider's cleanup on sign-out/user change.
    resolve("Made-up late response");
    await settled;
    expect(previous.getQueryCache().getAll()).toHaveLength(0);
    expect(next.getQueryCache().getAll()).toHaveLength(0);
    next.clear();
  });
});
