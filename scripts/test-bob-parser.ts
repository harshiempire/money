/* eslint-disable no-console */
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { bobAdapter } from "../src/domain/adapters/bob/parser";

const file = process.argv[2] ?? "./sample-data/transactions.pdf";
const pdfPassword = process.argv[3];
const buf = readFileSync(file);
const ctx = pdfPassword ? { pdfPassword } : {};

const program = Effect.gen(function* () {
  const detected = yield* bobAdapter.detect(buf, "application/pdf", ctx);
  console.log(`detect(${file}) = ${detected}`);
  if (!detected) return;

  const parsed = yield* bobAdapter.parse(buf, ctx);
  const { meta, rows } = parsed;

  console.log(`bank: ${meta.bank}`);
  console.log(`period: ${meta.periodStart} → ${meta.periodEnd}`);
  console.log(`rows: ${rows.length}`);

  // Counts
  const byChannel = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.channel] = (acc[r.channel] ?? 0) + 1;
    return acc;
  }, {});
  console.log("channel counts:", byChannel);

  const debits = rows.filter((r) => r.drCr === "debit");
  const credits = rows.filter((r) => r.drCr === "credit");
  console.log(`debits: ${debits.length}  credits: ${credits.length}`);

  const totalDebit = debits.reduce((s, r) => s + r.amountPaise, 0);
  const totalCredit = credits.reduce((s, r) => s + r.amountPaise, 0);
  console.log(
    `total debit: ₹${(totalDebit / 100).toLocaleString("en-IN")}  total credit: ₹${(totalCredit / 100).toLocaleString("en-IN")}`,
  );

  // Ref id coverage
  const withRef = rows.filter((r) => r.refId !== null).length;
  console.log(
    `ref ids parsed: ${withRef}/${rows.length} (${rows.length - withRef} without — likely Opening Balance)`,
  );

  // Balance trajectory check: opening + sum(credit) - sum(debit) ≈ closing
  const opening = rows[0]?.balancePaise ?? 0;
  const closing = rows[rows.length - 1]?.balancePaise ?? 0;
  const computed = opening + totalCredit - totalDebit;
  console.log(
    `opening: ₹${(opening / 100).toLocaleString("en-IN")}  closing: ₹${(closing / 100).toLocaleString("en-IN")}  computed-from-deltas: ₹${(computed / 100).toLocaleString("en-IN")}`,
  );

  // Spot-check: print first 5 + last 3 rows
  console.log("\n--- first 5 rows ---");
  for (const r of rows.slice(0, 5)) {
    console.log(
      `[${r.channel}] ${r.txnDate} ${r.drCr} ₹${(r.amountPaise / 100).toFixed(2)} ref=${r.refId ?? "—"} cp=${r.counterpartyKey ?? "—"} bal=${(r.balancePaise! / 100).toLocaleString("en-IN")}`,
    );
  }
  console.log("--- last 3 rows ---");
  for (const r of rows.slice(-3)) {
    console.log(
      `[${r.channel}] ${r.txnDate} ${r.drCr} ₹${(r.amountPaise / 100).toFixed(2)} ref=${r.refId ?? "—"} cp=${r.counterpartyKey ?? "—"} bal=${(r.balancePaise! / 100).toLocaleString("en-IN")}`,
    );
  }
});

await Effect.runPromise(program).catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
