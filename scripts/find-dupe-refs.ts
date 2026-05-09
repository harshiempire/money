/* eslint-disable no-console */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { bobAdapter } from "../src/domain/adapters/bob/parser";
import type { CanonicalTxn } from "../src/domain/canonical";

const buf = readFileSync("./sample-data/transactions.pdf");

const fallback = (r: CanonicalTxn) =>
  "fallback:" +
  createHash("sha256")
    .update(`${r.txnDate}|${r.amountPaise}|${r.drCr}|${r.rawDescription}`)
    .digest("hex")
    .slice(0, 24);

const program = Effect.gen(function* () {
  const parsed = yield* bobAdapter.parse(buf);
  const groups = new Map<string, { idx: number; r: CanonicalTxn }[]>();
  for (const [idx, r] of parsed.rows.entries()) {
    const ref = r.refId ?? fallback(r);
    const arr = groups.get(ref) ?? [];
    arr.push({ idx, r });
    groups.set(ref, arr);
  }
  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log("total rows:", parsed.rows.length);
  console.log("unique refs:", groups.size);
  console.log("duplicate-ref groups:", dupes.length);
  for (const [ref, arr] of dupes) {
    console.log("\n=== duplicate ref:", ref);
    for (const { idx, r } of arr) {
      const serial = (r.rawPayload as { serial?: number } | null)?.serial;
      console.log(
        `  [#${idx}] serial=${serial} date=${r.txnDate} ${r.drCr} ₹${(r.amountPaise / 100).toFixed(2)} ch=${r.channel}`,
      );
      console.log(`        desc=${JSON.stringify(r.rawDescription)}`);
    }
  }
});

await Effect.runPromise(program);
