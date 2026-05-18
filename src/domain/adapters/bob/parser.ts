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

// ─── Anchor regex ────────────────────────────────────────────────────────────
//
// Bank of Baroda PDFs (rendered through unpdf) emit each row as:
//
//   <balance><sr.no> <txn_date> [<value_date>] <description...>[\n<cont>]* <debit> <credit>
//
// The balance and serial number share a single token because both are
// right-aligned numerals, so unpdf concatenates them. Example anchors:
//
//   2,367.841 01-03-2026 Opening Balance - -
//   2,148.842 01-03-2026 01-03-2026 UPI/606005129527/16:39:36/UPI/swig...
//   1,17,119.308 06-03-2026 06-03-2026 NEFT-AXNH260650044005-GR0WW INV...
//
const MONEY = String.raw`\d{1,3}(?:,\d{2,3})*\.\d{2}`;
const ANCHOR = new RegExp(
  `^(${MONEY})(\\d+)\\s+(\\d{2}-\\d{2}-\\d{4})(?:\\s+(\\d{2}-\\d{2}-\\d{4}))?\\s+(.*)$`,
);

// Lines that show up between rows but don't belong to any row.
const FOOTER_PATTERNS = [
  /^This is a computer-generated/i,
  /^Page \d+ of \d+/,
  /^\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}/, // generation timestamp
  /^maintained in the bank/i,
];

const isFooter = (line: string) => FOOTER_PATTERNS.some((re) => re.test(line));

// Money or "-"
const TRAIL = new RegExp(String.raw`(${MONEY}|-)\s+(${MONEY}|-)$`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toIsoDate = (ddmmyyyy: string): string => {
  const [d, m, y] = ddmmyyyy.split("-");
  return `${y}-${m}-${d}`;
};

const toPaise = (s: string): number => {
  if (s === "-") return 0;
  const cleaned = s.replace(/,/g, "");
  const rupees = Number.parseFloat(cleaned);
  return Math.round(rupees * 100);
};

const detectChannel = (description: string): Channel => {
  if (description.startsWith("UPI/")) return "upi";
  if (description.startsWith("IMPS/")) return "imps";
  if (description.startsWith("NEFT")) return "neft";
  if (description.startsWith("RTGS")) return "rtgs";
  if (/Opening Balance/i.test(description)) return "opening";
  return "other";
};

interface Extracted {
  refId: string | null;
  counterpartyKey: string | null;
  parsedPurpose: string | null;
}

const extractFromDescription = (
  description: string,
  channel: Channel,
): Extracted => {
  // UPI: "UPI/<ref>/<HH:MM:SS>/<UPI|UDIR>/<handle>[/<purpose>]"
  // Wrap artifacts (e.g. "rohanrao.b- 1@okaxis") get removed by stripping
  // internal whitespace — UPI handles never legitimately contain spaces.
  if (channel === "upi") {
    const m = description.match(
      /^UPI\/(\d{6,})\/[\d:]+\/(?:UPI|UDIR)\/(.+)$/i,
    );
    if (m) {
      const tail = m[2].replace(/\s+/g, "");
      const slash = tail.indexOf("/");
      const handle = (slash === -1 ? tail : tail.slice(0, slash)).toLowerCase();
      const purpose = slash === -1 ? null : tail.slice(slash + 1) || null;
      return { refId: m[1], counterpartyKey: handle, parsedPurpose: purpose };
    }
  }

  // IMPS: "IMPS/P2A/<ref>/<payee>/<purpose>"
  if (channel === "imps") {
    const m = description.match(
      /^IMPS\/(?:P2A|P2P|P2M)\/(\d{6,})\/([^/\s][^/]*?)(?:\/(.*))?$/,
    );
    if (m) {
      return {
        refId: m[1],
        counterpartyKey: m[2].trim(),
        parsedPurpose: m[3]?.trim().replace(/\s+/g, "") ?? null,
      };
    }
  }

  // NEFT: "NEFT-<UTR>-<merchant>[ -]"
  if (channel === "neft") {
    const m = description.match(/^NEFT-([A-Z0-9]+)-(.+?)(?:\s*-\s*)?$/);
    if (m) {
      return {
        refId: m[1],
        counterpartyKey: m[2].trim(),
        parsedPurpose: null,
      };
    }
  }

  return { refId: null, counterpartyKey: null, parsedPurpose: null };
};

interface RawRow {
  balanceText: string;
  serial: number;
  txnDate: string; // dd-mm-yyyy
  valueDate: string | null; // dd-mm-yyyy
  descriptionLines: string[];
}

/**
 * Walk a page's lines and group them into rows. Rows start at "anchor" lines
 * (matching ANCHOR); subsequent non-anchor, non-footer lines are description
 * continuations.
 */
const collectRows = (lines: string[]): RawRow[] => {
  const rows: RawRow[] = [];
  let current: RawRow | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(ANCHOR);
    if (m) {
      if (current) rows.push(current);
      current = {
        balanceText: m[1],
        serial: Number.parseInt(m[2], 10),
        txnDate: m[3],
        valueDate: m[4] ?? null,
        descriptionLines: [m[5]],
      };
      continue;
    }

    if (current && !isFooter(line)) {
      current.descriptionLines.push(line);
    }
  }
  if (current) rows.push(current);
  return rows;
};

/**
 * Strip the trailing `<debit> <credit>` pair off the row's text and return
 * the description plus parsed amounts. The pair lives on whichever line has
 * the `<money|->` `<money|->` suffix.
 */
const splitDescriptionAndAmounts = (
  row: RawRow,
): {
  description: string;
  debit: string;
  credit: string;
} | null => {
  // The trailing pair is always on the LAST line of the row; everything
  // before it (across all lines) is description.
  const lines = [...row.descriptionLines];
  const last = lines[lines.length - 1];
  const trail = last.match(TRAIL);
  if (!trail) return null;

  const lastWithoutAmounts = last.slice(0, trail.index).trim();
  lines[lines.length - 1] = lastWithoutAmounts;

  // Join with space; collapse whitespace runs.
  const description = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .replace(/\s+/g, " ");

  return { description, debit: trail[1], credit: trail[2] };
};

const buildCanonical = (
  row: RawRow,
  description: string,
  debit: string,
  credit: string,
): CanonicalTxn => {
  const channel = detectChannel(description);
  const drCr = debit !== "-" ? "debit" : "credit";
  const amountText = drCr === "debit" ? debit : credit;
  const extracted = extractFromDescription(description, channel);

  return {
    txnDate: toIsoDate(row.txnDate),
    valueDate: row.valueDate ? toIsoDate(row.valueDate) : null,
    amountPaise: toPaise(amountText),
    drCr,
    channel,
    refId: extracted.refId,
    rawDescription: description,
    parsedPurpose: extracted.parsedPurpose,
    counterpartyKey: extracted.counterpartyKey,
    balancePaise: toPaise(row.balanceText),
    rawPayload: { serial: row.serial, balanceText: row.balanceText },
  };
};

// ─── Header parsing for the statement period ─────────────────────────────────

const PERIOD_RE =
  /Account Statement from (\d{2}-\d{2}-\d{4}) to (\d{2}-\d{2}-\d{4})/;

const extractPeriod = (firstPageText: string) => {
  const m = firstPageText.match(PERIOD_RE);
  if (!m) return { periodStart: null, periodEnd: null };
  return { periodStart: toIsoDate(m[1]), periodEnd: toIsoDate(m[2]) };
};

// ─── Adapter ─────────────────────────────────────────────────────────────────

export const bobAdapter: BankAdapter = {
  name: "bob",

  detect: (file, mime, ctx) =>
    Effect.gen(function* () {
      // Quick sniff: PDF with the "bob World" or BoB statement header in it.
      if (!mime.includes("pdf") && !file.subarray(0, 4).toString().includes("PDF")) {
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
              bank: "bob",
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
      return /bob World|Bank of Baroda|BARB0/.test(blob);
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
            bank: "bob",
            stage: "extractText",
            detail: String(e),
          });
        },
      });

      const pages = (Array.isArray(text) ? text : [text]).map((p) => p ?? "");
      if (pages.length === 0) {
        return yield* Effect.fail(
          new ParseError({
            bank: "bob",
            stage: "pages",
            detail: "PDF had no extractable pages",
          }),
        );
      }

      const period = extractPeriod(pages[0]);

      const rows: CanonicalTxn[] = [];
      for (const page of pages) {
        const lines = page.split("\n");
        for (const raw of collectRows(lines)) {
          const split = splitDescriptionAndAmounts(raw);
          if (!split) {
            // A row whose trailing dr/cr pair we couldn't find is a parser
            // bug or a pathological row; surface it loudly.
            return yield* Effect.fail(
              new ParseError({
                bank: "bob",
                stage: "splitAmounts",
                detail: `Sr.No ${raw.serial}: could not find debit/credit pair in ${JSON.stringify(
                  raw.descriptionLines,
                )}`,
              }),
            );
          }
          rows.push(
            buildCanonical(raw, split.description, split.debit, split.credit),
          );
        }
      }

      const result: ParsedStatement = {
        meta: {
          bank: "bob",
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
        },
        rows,
      };
      return result;
    }),
};
