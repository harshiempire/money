/* eslint-disable no-console */
/**
 * Compare two BoB statement PDFs (old vs new format).
 * Usage: bun run scripts/compare-bob-pdfs.ts <old.pdf> <new.pdf> [password]
 */
import { readFileSync } from "node:fs";
import { Effect, Either } from "effect";
import { bobAdapter } from "../src/domain/adapters/bob/parser";
import { extractPdfText } from "../src/domain/pdf/extract";

const log = (message: string, data: Record<string, unknown>) => {
  console.log(message, data);
};

const ANCHOR_SAMPLE =
  /^\d{1,3}(?:,\d{2,3})*\.\d{2}\d+\s+\d{2}-\d{2}-\d{4}/;

const PERIOD_RE =
  /Account Statement from (\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})/;

async function analyzePdf(label: string, path: string, password?: string) {
  const buf = readFileSync(path);
  const ctx = password ? { pdfPassword: password } : {};

  log("file loaded", { label, path, bytes: buf.length });

  const detected = await Effect.runPromise(
    Effect.either(bobAdapter.detect(buf, "application/pdf", ctx)),
  );
  if (Either.isLeft(detected)) {
    log("detect failed", { label, error: String(detected.left) });
    return null;
  }
  log("detect result", { label, detected: detected.right });

  const { text, totalPages } = await extractPdfText(new Uint8Array(buf), {
    password: ctx.pdfPassword,
    mergePages: false,
  });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p ?? "");

  const firstPage = pages[0] ?? "";
  const periodMatch = firstPage.match(PERIOD_RE);
  const allLines = pages.flatMap((p) => p.split("\n").map((l) => l.trim()).filter(Boolean));
  const anchorLines = allLines.filter((l) => ANCHOR_SAMPLE.test(l));
  const nonAnchorTxnish = allLines.filter(
    (l) =>
      /\d{2}-\d{2}-\d{4}/.test(l) &&
      !ANCHOR_SAMPLE.test(l) &&
      !/^Page \d+/.test(l) &&
      !/^Account Statement/.test(l),
  );

  log("raw text shape", {
    label,
    totalPages,
    firstPageChars: firstPage.length,
    periodHeader: periodMatch ? `${periodMatch[1]} → ${periodMatch[2]}` : null,
    totalLines: allLines.length,
    anchorLineCount: anchorLines.length,
    nonAnchorTxnishCount: nonAnchorTxnish.length,
    firstAnchorSample: anchorLines[0]?.slice(0, 120) ?? null,
    lastAnchorSample: anchorLines.at(-1)?.slice(0, 120) ?? null,
    firstNonAnchorSample: nonAnchorTxnish[0]?.slice(0, 120) ?? null,
  });

  const parsed = await Effect.runPromise(
    Effect.either(bobAdapter.parse(buf, ctx)),
  );
  if (Either.isLeft(parsed)) {
    const err = parsed.left;
    log("parse failed", {
      label,
      tag: err._tag,
      stage: "_tag" in err && err._tag === "ParseError" ? err.stage : undefined,
      detail: "_tag" in err && err._tag === "ParseError" ? err.detail : String(err),
    });
    return { label, parseFailed: true as const };
  }

  const { meta, rows } = parsed.right;
  const txnDates = rows.map((r) => r.txnDate).filter((d) => d !== rows[0]?.txnDate || rows[0]?.channel !== "opening");
  const uniqueRefs = new Set(rows.map((r) => r.refId).filter(Boolean));

  log("parse success", {
    label,
    periodStart: meta.periodStart,
    periodEnd: meta.periodEnd,
    rowCount: rows.length,
    firstTxnDate: rows[0]?.txnDate ?? null,
    lastTxnDate: rows.at(-1)?.txnDate ?? null,
    debitCount: rows.filter((r) => r.drCr === "debit").length,
    creditCount: rows.filter((r) => r.drCr === "credit").length,
    refIdCount: uniqueRefs.size,
    channels: rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.channel] = (acc[r.channel] ?? 0) + 1;
      return acc;
    }, {}),
  });

  return {
    label,
    parseFailed: false as const,
    meta,
    rows,
    txnDates,
    refIds: [...uniqueRefs],
  };
}

const oldPath = process.argv[2];
const newPath = process.argv[3];
const password = process.argv[4];

if (!oldPath || !newPath) {
  console.error(
    "Usage: bun run scripts/compare-bob-pdfs.ts <old.pdf> <new.pdf> [password]",
  );
  process.exit(1);
}

console.log("Comparing BoB PDFs…");
console.log(`  old: ${oldPath}`);
console.log(`  new: ${newPath}`);

const old = await analyzePdf("old", oldPath, password);
const newer = await analyzePdf("new", newPath, password);

if (old && !old.parseFailed && newer && !newer.parseFailed) {
  const oldRefs = new Set(old.refIds);
  const newRefs = new Set(newer.refIds);
  const onlyInNew = newer.refIds.filter((r) => !oldRefs.has(r));
  const onlyInOld = old.refIds.filter((r) => !newRefs.has(r));
  const overlap = newer.refIds.filter((r) => oldRefs.has(r));

  log("ref overlap between files", {
    oldRowCount: old.rows.length,
    newRowCount: newer.rows.length,
    overlapRefCount: overlap.length,
    onlyInNewRefCount: onlyInNew.length,
    onlyInOldRefCount: onlyInOld.length,
    oldPeriod: `${old.meta.periodStart} → ${old.meta.periodEnd}`,
    newPeriod: `${newer.meta.periodStart} → ${newer.meta.periodEnd}`,
    sampleOnlyInNew: onlyInNew.slice(0, 5),
  });

  console.log("\n--- Summary ---");
  console.log(`Old: ${old.rows.length} rows, period ${old.meta.periodStart} → ${old.meta.periodEnd}`);
  console.log(`New: ${newer.rows.length} rows, period ${newer.meta.periodStart} → ${newer.meta.periodEnd}`);
  console.log(`Ref overlap: ${overlap.length}, only in new: ${onlyInNew.length}, only in old: ${onlyInOld.length}`);
}
