/**
 * Integration check for statement upload (and the spend read) against the
 * Neon `local-dev` branch ONLY. Never production.
 *
 * Uses the private sample statements in sample-data/ (git-ignored) when
 * present; the PDF cases are skipped, with a note, when they aren't.
 * Throwaway user; everything is removed afterwards.
 *
 *   DATABASE_URL="$(cat ~/.money-scratch/local-dev/dburl)" \
 *     bun run --conditions=react-server --preload="$HOME/.money-scratch/neon-dns.cjs" \
 *     scripts/test-import-actions.ts
 */
export {};

const LOCAL_DEV_ENDPOINT = "<local-dev-endpoint>";
if (!process.env.DATABASE_URL?.includes(LOCAL_DEV_ENDPOINT)) {
  console.error(`Refusing to run: DATABASE_URL is not the local-dev branch (${LOCAL_DEV_ENDPOINT}).`);
  process.exit(2);
}

const { existsSync, readFileSync } = await import("node:fs");
const { eq, inArray } = await import("drizzle-orm");
const { Layer } = await import("effect");
const { db, schema } = await import("../src/db");
const { runAction } = await import("../src/lib/action/core");
const { CurrentUser, Db } = await import("../src/lib/action/services");
const { uploadStatementSpec } = await import("../src/app/import/import-handlers");
const { getCategoryTransactionsSpec } = await import("../src/app/spend/spend-handlers");

type Result = { ok: boolean; code?: string; message?: string; field?: string; data?: any };
const userId = crypto.randomUUID();
const failures: string[] = [];
let passed = 0;
function expect(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 300)); }
}
const layer = Layer.merge(Layer.succeed(CurrentUser, { id: userId, email: null }), Layer.succeed(Db, db));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (spec: any, input: unknown) => runAction(spec, input, { name: "test", layer, log: () => {} }) as Promise<Result>;
const form = (file?: File, pw?: string) => { const f = new FormData(); if (file) f.set("file", file); if (pw !== undefined) f.set("pdfPassword", pw); return f; };
const pdf = (name: string) => new File([readFileSync(`sample-data/${name}`)], name, { type: "application/pdf" });

try {
  await db.insert(schema.users).values({ id: userId, email: `import-test+${userId}@example.invalid` });

  console.log("upload: bad input");
  let r = await call(uploadStatementSpec, form());
  expect("no file → INVALID 'No file uploaded' (field file)", r.code === "INVALID" && r.message === "No file uploaded" && r.field === "file", r);
  r = await call(uploadStatementSpec, form(new File(["hello"], "notes.txt", { type: "text/plain" })));
  expect("not a statement → 'No bank adapter recognized this file…'", r.message === "No bank adapter recognized this file. Try the generic CSV mapper.", r);
  r = await call(uploadStatementSpec, { file: "not a form" });
  expect("non-FormData input → INVALID", r.code === "INVALID", r);

  if (existsSync("sample-data/may-new.pdf") && existsSync("sample-data/may-new-unlocked.pdf")) {
    console.log("upload: sample statements");
    r = await call(uploadStatementSpec, form(pdf("may-new.pdf")));
    expect("locked PDF, no password → password message (field pdfPassword)", r.field === "pdfPassword" && r.message?.startsWith("This PDF is password-protected.") === true, r);
    r = await call(uploadStatementSpec, form(pdf("may-new.pdf"), " wrong "));
    expect("wrong password → 'Incorrect PDF password…'", r.message === "Incorrect PDF password. Check the password your bank sent with the statement.", r);
    r = await call(uploadStatementSpec, form(pdf("may-new-unlocked.pdf"), ""));
    expect("unlocked statement → ok, 70 seen / 70 new", r.ok && r.data.summary.rowsSeen === 70 && r.data.summary.rowsNew === 70 && r.data.bank === "bob", r.data?.summary);
    expect("…review link points at this import", r.ok && r.data.reviewHref === `/transactions?import=${encodeURIComponent(r.data.summary.importId)}&attention=1&all=1`, r.data?.reviewHref);
    r = await call(uploadStatementSpec, form(pdf("may-new-unlocked.pdf")));
    expect("same statement again → 70 duplicates, 0 new", r.ok && r.data.summary.rowsDuplicate === 70 && r.data.summary.rowsNew === 0, r.data?.summary);

    console.log("spend read");
    r = await call(getCategoryTransactionsSpec, { categoryId: null, from: null, to: null });
    expect("uncategorised transactions for the period → 69 rows (opening row excluded)", r.ok && Array.isArray(r.data) && r.data.length === 69, r.ok ? r.data.length : r);
  } else {
    console.log("  (sample-data/*.pdf not present — PDF cases skipped)");
  }
} finally {
  const accts = await db.select().from(schema.moneyAccounts).where(eq(schema.moneyAccounts.userId, userId));
  if (accts.length) await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accts.map((a) => a.id)));
  await db.delete(schema.counterparties).where(eq(schema.counterparties.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  const left = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  console.log(`\ncleanup: test user ${left.length ? "STILL PRESENT" : "deleted"}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  process.exit(failures.length === 0 ? 0 : 1);
}
