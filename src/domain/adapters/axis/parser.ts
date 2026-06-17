import { Effect, Either } from "effect";
import {
  ParseError,
  PdfPasswordError,
  type CanonicalTxn,
  type Channel,
  type ParsedStatement,
} from "../../canonical";
import { extractPdfText, toPdfPasswordError } from "../../pdf/extract";
import type { BankAdapter } from "../index";

// ─── Patterns ────────────────────────────────────────────────────────────────
//
// Axis Bank statement PDF (text extraction via unpdf) layout:
//
//   Header block (legends, customer info)
//   Statement of Axis Account No :XXXXXX for the period (From : DD-MM-YYYY To : DD-MM-YYYY)
//   Tran Date  Chq No  Particulars                    Debit  Credit  Balance  Init.
//   Br
//   OPENING BALANCE  1997657.56
//   12-06-2026  UPI/P2M/616343669972/Hyderabad Metro
//   /Sent u/YES BANK LIMITED YBS  47.00  1997610.56  1381
//   TRANSACTION TOTAL  177.00  .00
//   CLOSING BALANCE  1997480.56
//
// Each transaction row starts with a DD-MM-YYYY anchor. The description may
// wrap across the next line(s). The final line of each row ends with:
//   {amount}  {running_balance}  {branch_code}
// where only the filled Debit or Credit column appears (blank columns are
// absent in the text extraction).
//
// Matches DD-MM-YYYY optionally followed by description text on the same line.
// Some PDFs put the date alone on one line and the description on the next.
const TXN_DATE_ANCHOR = /^(\d{2}-\d{2}-\d{4})(?:\s+(.*))?$/;

// Amount: optional leading comma-separated digits, mandatory decimal pair.
const AMT = String.raw`\d[\d,]*\.\d{2}`;
// A row's last line ends with: amount  balance  branch(integer)
const ROW_TAIL = new RegExp(
  String.raw`^(.*)\s+(${AMT})\s+(${AMT})\s+(\d+)\s*$`,
);

const PERIOD_RE =
  /for the period\s*\(From\s*:\s*(\d{2}-\d{2}-\d{4})\s+To\s*:\s*(\d{2}-\d{2}-\d{4})\)/i;

// Lines to skip when we are inside the transaction body
const BODY_SKIP = [
  /^TRANSACTION TOTAL/i,
  /^Tran Date\s+Chq/i,
  /^Br\s*$/,
  /^Page \d+/i,
];

const isBodySkip = (line: string) => BODY_SKIP.some((re) => re.test(line));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toIsoDate = (ddmmyyyy: string): string => {
  const [d, m, y] = ddmmyyyy.split("-");
  return `${y}-${m}-${d}`;
};

const toPaise = (s: string): number =>
  Math.round(parseFloat(s.replace(/,/g, "")) * 100);

const detectChannel = (narration: string): Channel => {
  const u = narration.toUpperCase();
  if (u.startsWith("UPI/")) return "upi";
  if (u.startsWith("IMPS/")) return "imps";
  if (/^NEFT[/ -]/.test(u)) return "neft";
  if (/^RTGS[/ -]/.test(u)) return "rtgs";
  if (/^CWDR/.test(u)) return "cash";
  if (/^PUR\b|^POS\b/.test(u)) return "card";
  if (/OPENING BALANCE/i.test(narration)) return "opening";
  return "other";
};

interface Extracted {
  refId: string | null;
  counterpartyKey: string | null;
  parsedPurpose: string | null;
}

const extractFromNarration = (narration: string, channel: Channel): Extracted => {
  // UPI/P2M/<ref>/<merchant description>/Sent u/<bank>   (person-to-merchant)
  // UPI/P2A/<ref>/<payee name>/UPI/<bank>                (person-to-account)
  // UPI/P2P/<ref>/<handle>                               (person-to-person)
  if (channel === "upi") {
    const m = narration.match(/^UPI\/\w+\/(\d{6,})\/(.*)$/i);
    if (m) {
      const raw = m[2].trim();
      // Strip bank-routing suffixes: "/Sent u/", "/UPI/", "/NEFT/"
      const cutPoints = ["/Sent u/", "/UPI/", "/NEFT/"]
        .map((sep) => raw.indexOf(sep))
        .filter((i) => i > 0);
      const cut = cutPoints.length > 0 ? Math.min(...cutPoints) : raw.length;
      const counterpartyKey = raw.slice(0, cut).trim().replace(/\s+/g, " ") || null;
      return { refId: m[1], counterpartyKey, parsedPurpose: null };
    }
  }

  // IMPS/<ref>/<payee>
  if (channel === "imps") {
    const m = narration.match(/^IMPS\/(\d+)\/(.*)$/i);
    if (m) {
      return {
        refId: m[1],
        counterpartyKey: m[2]?.trim() || null,
        parsedPurpose: null,
      };
    }
  }

  // NEFT/<UTR>/<payee>  or  NEFT-<UTR>-<payee>
  if (channel === "neft") {
    const m = narration.match(/^NEFT[/ -]([A-Z0-9]+)[/ -](.*)$/i);
    if (m) {
      return {
        refId: m[1],
        counterpartyKey: m[2]?.trim() || null,
        parsedPurpose: null,
      };
    }
  }

  return { refId: null, counterpartyKey: null, parsedPurpose: null };
};

// ─── Row collection ───────────────────────────────────────────────────────────

interface RawRow {
  txnDate: string; // DD-MM-YYYY
  bodyLines: string[];
}

interface Collected {
  openingBalance: number | null;
  rows: RawRow[];
}

const collectAxisRows = (allLines: string[]): Collected => {
  let inBody = false;
  let openingBalance: number | null = null;
  const rows: RawRow[] = [];
  let current: RawRow | null = null;

  for (const rawLine of allLines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (!inBody) {
      const ob = line.match(/^OPENING BALANCE\s+([\d,]+\.\d{2})/i);
      if (ob) {
        inBody = true;
        openingBalance = toPaise(ob[1]);
      }
      continue;
    }

    if (/^CLOSING BALANCE/i.test(line) || /^\+\+\+\+/.test(line)) {
      if (current) {
        rows.push(current);
        current = null;
      }
      break;
    }

    if (isBodySkip(line)) continue;

    const dateMatch = line.match(TXN_DATE_ANCHOR);
    if (dateMatch) {
      if (current) rows.push(current);
      const rest = dateMatch[2] ?? "";
      current = { txnDate: dateMatch[1], bodyLines: rest ? [rest] : [] };
      // Single-line transaction: date + amounts on the same line.
      if (rest && ROW_TAIL.test(rest)) {
        rows.push(current);
        current = null;
      }
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
      // Finalize as soon as we see the tail — prevents page-header/legend lines
      // that follow the tail (on the next page) from leaking into this row.
      if (ROW_TAIL.test(line)) {
        rows.push(current);
        current = null;
      }
    }
  }

  if (current) rows.push(current);
  return { openingBalance, rows };
};

// ─── Row → CanonicalTxn ───────────────────────────────────────────────────────

const buildCanonical = (
  raw: RawRow,
  prevBalance: number | null,
  serial: number,
): CanonicalTxn | null => {
  const text = raw.bodyLines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");

  const tail = text.match(ROW_TAIL);
  if (!tail) return null;

  const description = tail[1].trim();
  const amountPaise = toPaise(tail[2]);
  const balancePaise = toPaise(tail[3]);
  const branch = tail[4];

  const drCr: "debit" | "credit" =
    prevBalance !== null && balancePaise > prevBalance ? "credit" : "debit";

  const channel = detectChannel(description);
  const extracted = extractFromNarration(description, channel);

  return {
    txnDate: toIsoDate(raw.txnDate),
    valueDate: null,
    amountPaise,
    drCr,
    channel,
    refId: extracted.refId,
    rawDescription: description,
    parsedPurpose: extracted.parsedPurpose,
    counterpartyKey: extracted.counterpartyKey,
    balancePaise,
    rawPayload: { serial, branch },
  };
};

// ─── Period extraction ────────────────────────────────────────────────────────

const extractPeriod = (blob: string) => {
  const m = blob.match(PERIOD_RE);
  if (!m) return { periodStart: null, periodEnd: null };
  return { periodStart: toIsoDate(m[1]), periodEnd: toIsoDate(m[2]) };
};

// ─── Main parse function ──────────────────────────────────────────────────────

const parseAxisPages = (
  pages: string[],
  periodStart: string | null,
): Effect.Effect<CanonicalTxn[], ParseError> =>
  Effect.gen(function* () {
    const allLines = pages.join("\n").split("\n");
    const { openingBalance, rows } = collectAxisRows(allLines);

    const txns: CanonicalTxn[] = [];
    let prevBalance = openingBalance;
    let serial = 0;

    // Opening balance pseudo-row — date is period start, or first txn date as fallback.
    if (openingBalance !== null) {
      const obDate =
        periodStart ?? (rows[0] ? toIsoDate(rows[0].txnDate) : null);
      if (obDate) {
        serial++;
        txns.push({
          txnDate: obDate,
          valueDate: null,
          amountPaise: 0,
          drCr: "credit",
          channel: "opening",
          refId: null,
          rawDescription: "Opening Balance",
          parsedPurpose: null,
          counterpartyKey: null,
          balancePaise: openingBalance,
          rawPayload: { serial, openingBalance },
        });
      }
    }

    for (const raw of rows) {
      serial++;
      const canonical = buildCanonical(raw, prevBalance, serial);
      if (!canonical) {
        return yield* Effect.fail(
          new ParseError({
            bank: "axis",
            stage: "splitAmounts",
            detail: `Row on ${raw.txnDate}: could not parse amount/balance tail from: ${JSON.stringify(raw.bodyLines)}`,
          }),
        );
      }
      txns.push(canonical);
      prevBalance = canonical.balancePaise;
    }

    return txns;
  });

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const axisAdapter: BankAdapter = {
  name: "axis",

  detect: (file, mime, ctx) =>
    Effect.gen(function* () {
      if (
        !mime.includes("pdf") &&
        !file.subarray(0, 4).toString().includes("PDF")
      ) {
        return false;
      }
      const extracted = yield* Effect.either(
        Effect.tryPromise({
          try: () =>
            extractPdfText(new Uint8Array(file), {
              password: ctx.pdfPassword,
              mergePages: true,
            }),
          catch: (e) => {
            if (e instanceof PdfPasswordError) return e;
            const passwordErr = toPdfPasswordError(e);
            if (passwordErr) return passwordErr;
            return new ParseError({
              bank: "axis",
              stage: "extractText",
              detail: String(e),
            });
          },
        }),
      );
      if (Either.isLeft(extracted)) {
        if (extracted.left._tag === "PdfPasswordError") {
          return yield* Effect.fail(extracted.left);
        }
        return false;
      }
      const { text } = extracted.right;
      const blob = Array.isArray(text) ? text.join(" ") : text;
      return /Statement of Axis Account|Axis Bank|UTIB\d{7}/.test(blob);
    }),

  parse: (file, ctx) =>
    Effect.gen(function* () {
      const { text } = yield* Effect.tryPromise({
        try: () =>
          extractPdfText(new Uint8Array(file), {
            password: ctx.pdfPassword,
            mergePages: false,
          }),
        catch: (e) => {
          if (e instanceof PdfPasswordError) return e;
          const passwordErr = toPdfPasswordError(e);
          if (passwordErr) return passwordErr;
          return new ParseError({
            bank: "axis",
            stage: "extractText",
            detail: String(e),
          });
        },
      });

      const pages = (Array.isArray(text) ? text : [text]).map((p) => p ?? "");
      if (pages.length === 0) {
        return yield* Effect.fail(
          new ParseError({
            bank: "axis",
            stage: "pages",
            detail: "PDF had no extractable pages",
          }),
        );
      }

      const period = extractPeriod(pages.join("\n"));
      const rows = yield* parseAxisPages(pages, period.periodStart);

      const result: ParsedStatement = {
        meta: {
          bank: "axis",
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        },
        rows,
      };

      return result;
    }),
};
