/* eslint-disable no-console */
/**
 * One-off: parse BoB SMS blobs and verify AvlBal chain + credit/debit coverage.
 */

const MESSAGES = `
Dear BOB UPI User: Your account is credited with INR 215.00 on 2026-05-12 02:48:55 PM by UPI Ref No 613283315428; AvlBal: Rs43440.97 - BOB
Rs.38.00 Dr. from A/C XXXXXX6670 and Cr. to gpay-11244491673@okbizaxis. Ref:194435120714. AvlBal:Rs43402.97(2026:05:12 07:44:36). Not you? Call 18005700/5000-BOB
Rs.800.00 Dr. from A/C XXXXXX6670 and Cr. to nagasaiaryan@okaxis. Ref:613359703613. AvlBal:Rs42602.97(2026:05:13 07:46:11). Not you? Call 18005700/5000-BOB
Rs.450.00 Dr. from A/C XXXXXX6670 and Cr. to reddysavithri13@okaxis. Ref:203622180746. AvlBal:Rs42018.97(2026:05:13 08:36:23). Not you? Call 18005700/5000-BOB
Rs.300.00 Dr. from A/C XXXXXX6670 and Cr. to paytm.s1s5smp@pty. Ref:224140468967. AvlBal:Rs41718.97(2026:05:13 10:41:41). Not you? Call 18005700/5000-BOB
Rs.421.24 Dr. from A/C XXXXXX6670 and Cr. to Q281213925@ybl. Ref:184113423698. AvlBal:Rs41297.73(2026:05:14 06:41:14). Not you? Call 18005700/5000-BOB
Rs.10.00 Dr. from A/C XXXXXX6670 and Cr. to paytm.s1zci1f@pty. Ref:184523989713. AvlBal:Rs41287.73(2026:05:14 06:45:25). Not you? Call 18005700/5000-BOB
Dear BOB UPI User: Your account is credited with INR 662.00 on 2026-05-14 08:09:31 PM by UPI Ref No 123131602611; AvlBal: Rs41949.73 - BOB
Rs.2100.00 Dr. from A/C XXXXXX6670 and Cr. to paytm.d17388634628@pty. Ref:205852863454. AvlBal:Rs39849.73(2026:05:15 08:58:54). Not you? Call 18005700/5000-BOB
Rs.398.00 Dr. from A/C XXXXXX6670 and Cr. to amznplpvrv6001087@rapl. Ref:190524355391. AvlBal:Rs39201.73(2026:05:16 07:05:26). Not you? Call 18005700/5000-BOB
Dear BOB UPI User: Your account is credited with INR 1164.03 on 2026-05-16 09:08:51 PM by UPI Ref No 613699520486; AvlBal: Rs40365.76 - BOB
Rs.564.90 Dr. from A/C XXXXXX6670 and Cr. to burgerking-2.bdpg@kotakpay. Ref:220353563657. AvlBal:Rs39800.86(2026:05:16 10:03:54). Not you? Call 18005700/5000-BOB
Rs.89.24 Dr. from A/C XXXXXX6670 and Cr. to burgerking-2.bdpg@kotakpay. Ref:223624128234. AvlBal:Rs39711.62(2026:05:16 10:36:25). Not you? Call 18005700/5000-BOB
Rs.180.00 Dr. from A/C XXXXXX6670 and Cr. to Vyapar.170560633466@hdfcbank. Ref:225355132185. AvlBal:Rs39531.62(2026:05:16 10:53:56). Not you? Call 18005700/5000-BOB
Dear BOB UPI User: Your account is credited with INR 615.00 on 2026-05-17 10:22:25 PM by UPI Ref No 613753186676; AvlBal: Rs40146.62 - BOB
Rs.386.00 Dr. from A/C XXXXXX6670 and Cr. to kamalkumarkonduri26@okicici. Ref:100449493336. AvlBal:Rs39760.62(2026:05:18 10:04:50). Not you? Call 18005700/5000-BOB
Dear BOB UPI User: Your account is credited with INR 239.00 on 2026-05-18 03:14:18 PM by UPI Ref No 613888693302; AvlBal: Rs39999.62 - BOB
Dear BOB UPI User: Your account is credited with INR 420.00 on 2026-05-18 03:17:04 PM by UPI Ref No 650494277486; AvlBal: Rs40419.62 - BOB
Rs.800.00 Dr. from A/C XXXXXX6670 and Cr. to dqrbp.82775126@axisbank. Ref:195937118172. AvlBal:Rs39619.62(2026:05:18 07:59:38). Not you? Call 18005700/5000-BOB
Rs.532.00 Dr. from A/C XXXXXX6670 and Cr. to Vyapar.173809277993@hdfcbank. Ref:230423171833. AvlBal:Rs39087.62(2026:05:18 11:04:24). Not you? Call 18005700/5000-BOB
Rs.270.00 Dr. from A/C XXXXXX6670 and Cr. to Vyapar.173809277993@hdfcbank. Ref:191526013290. AvlBal:Rs38817.62(2026:05:19 07:15:27). Not you? Call 18005700/5000-BOB
Dear BOB UPI User: Your account is credited with INR 328.00 on 2026-05-20 04:27:02 PM by UPI Ref No 162700403209; AvlBal: Rs39145.62 - BOB
Dear BOB UPI User: Your account is credited with INR 2000.00 on 2026-05-22 04:17:35 PM by UPI Ref No 614261142642; AvlBal: Rs41145.62 - BOB
Rs.331.00 Dr. from A/C XXXXXX6670 and Cr. to bsrusindhu@oksbi. Ref:246527739077. AvlBal:Rs40814.62(2026:05:23 04:46:57). Not you? Call 18005700/5000-BOB
Rs.140.00 Dr. from A/C XXXXXX6670 and Cr. to devaravikishore@oksbi. Ref:399679373679. AvlBal:Rs40674.62(2026:05:23 04:47:43). Not you? Call 18005700/5000-BOB
Rs.47.00 Dr. from A/C XXXXXX6670 and Cr. to 8125313891@axl. Ref:600994817726. AvlBal:Rs40627.62(2026:05:23 04:47:59). Not you? Call 18005700/5000-BOB
Rs.168.00 Dr. from A/C XXXXXX6670 and Cr. to 7075077077@axl. Ref:186354897219. AvlBal:Rs40459.62(2026:05:23 04:50:05). Not you? Call 18005700/5000-BOB
Rs.123.00 Dr. from A/C XXXXXX6670 and Cr. to jayashreebheema@okhdfcbank. Ref:818360064534. AvlBal:Rs40336.62(2026:05:23 04:50:17). Not you? Call 18005700/5000-BOB
Rs.220.00 Dr. from A/C XXXXXX6670 and Cr. to Vyapar.170266874439@hdfcbank. Ref:125610075165. AvlBal:Rs39866.62(2026:05:25 12:56:11). Not you? Call 18005700/5000-BOB
Dear BOB UPI User: Your account is credited with INR 100.00 on 2026-05-25 02:40:00 PM by UPI Ref No 614504604364; AvlBal: Rs39966.62 - BOB
Rs.420.00 Dr. from A/C XXXXXX6670 and Cr. to paytm.s1fxksx@pty. Ref:184021126231. AvlBal:Rs39546.62(2026:05:25 06:40:23). Not you? Call 18005700/5000-BOB
Rs.10.00 Dr. from A/C XXXXXX6670 and Cr. to 6075320957004327@ybl. Ref:184417068911. AvlBal:Rs39536.62(2026:05:25 06:44:19). Not you? Call 18005700/5000-BOB
Rs.66.00 Dr. from A/C XXXXXX6670 and Cr. to rohanrao.b-1@okaxis. Ref:651192105748. AvlBal:Rs39470.62(2026:05:25 10:18:20). Not you? Call 18005700/5000-BOB
Rs.209.00 Dr. from A/C XXXXXX6670 and Cr. to paytmqr2810050501011rt4p4a015tc@paytm. Ref:131620678319. AvlBal:Rs39261.62(2026:05:26 01:16:22). Not you? Call 18005700/5000-BOB
`.trim();

interface Parsed {
  lineNo: number;
  drCr: "debit" | "credit";
  amount: number;
  refId: string;
  counterparty: string | null;
  avlBal: number;
  ts: Date;
  tsRaw: string;
}

const CREDIT_RE =
  /credited with INR (\d+\.\d{2}) on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (?:AM|PM)) by UPI Ref No (\d+); AvlBal: Rs(\d+\.\d{2})/i;

const DEBIT_RE =
  /Rs\.(\d+\.\d{2}) Dr\. from A\/C \S+ and Cr\. to (.+?)\. Ref:(\d+)\. AvlBal:Rs(\d+\.\d{2})\((\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2})\)/i;

const parseTsCredit = (s: string): Date => new Date(s.replace(" ", "T").replace(/ (AM|PM)/, " $1"));

const parseTsDebit = (s: string): Date => {
  const [date, time] = s.split(" ");
  const [y, m, d] = date.split(":");
  return new Date(`${y}-${m}-${d}T${time}`);
};

const lines = MESSAGES.split("\n").filter((l) => l.trim());

const parsed: Parsed[] = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]!;
  const cr = line.match(CREDIT_RE);
  if (cr) {
    parsed.push({
      lineNo: i + 1,
      drCr: "credit",
      amount: Number.parseFloat(cr[1]!),
      refId: cr[3]!,
      counterparty: null,
      avlBal: Number.parseFloat(cr[4]!),
      ts: parseTsCredit(cr[2]!),
      tsRaw: cr[2]!,
    });
    continue;
  }
  const dr = line.match(DEBIT_RE);
  if (dr) {
    parsed.push({
      lineNo: i + 1,
      drCr: "debit",
      amount: Number.parseFloat(dr[1]!),
      refId: dr[3]!,
      counterparty: dr[2]!.trim(),
      avlBal: Number.parseFloat(dr[4]!),
      ts: parseTsDebit(dr[5]!),
      tsRaw: dr[5]!,
    });
    continue;
  }
  console.error("UNPARSED line", i + 1, line.slice(0, 80));
}

const credits = parsed.filter((p) => p.drCr === "credit");
const debits = parsed.filter((p) => p.drCr === "debit");

console.log("=== FORMAT COVERAGE ===");
console.log(`Total lines: ${lines.length}`);
console.log(`Parsed: ${parsed.length}`);
console.log(`Credits: ${credits.length}`);
console.log(`Debits: ${debits.length}`);

const byRef = new Map<string, Parsed[]>();
for (const p of parsed) {
  const arr = byRef.get(p.refId) ?? [];
  arr.push(p);
  byRef.set(p.refId, arr);
}
const dupRefs = [...byRef.entries()].filter(([, v]) => v.length > 1);
if (dupRefs.length) {
  console.log("\nDuplicate refIds:", dupRefs);
}

console.log("\n=== PASTE ORDER: AvlBal chain ===");
let breaksPaste = 0;
for (let i = 1; i < parsed.length; i++) {
  const prev = parsed[i - 1]!;
  const cur = parsed[i]!;
  const delta = cur.drCr === "credit" ? cur.amount : -cur.amount;
  const expected = Math.round((prev.avlBal + delta) * 100) / 100;
  const ok = Math.abs(expected - cur.avlBal) < 0.001;
  if (!ok) {
    breaksPaste++;
    const gap = Math.round((prev.avlBal - cur.avlBal) * 100) / 100;
    const explained =
      cur.drCr === "debit" ? cur.amount : -cur.amount;
    const missing = Math.round((gap - explained) * 100) / 100;
    console.log(
      `BREAK paste #${prev.lineNo} → #${cur.lineNo}: prevBal ${prev.avlBal} ${cur.drCr} ${cur.amount} => expect ${expected}, got ${cur.avlBal} (gap ${gap}, unexplained ${missing})`,
    );
  }
}
if (breaksPaste === 0) console.log("All consecutive rows in PASTE order match.");

const chrono = [...parsed].sort((a, b) => a.ts.getTime() - b.ts.getTime());

console.log("\n=== CHRONOLOGICAL ORDER: AvlBal chain ===");
let breaksChrono = 0;
const chronoBreaks: string[] = [];
for (let i = 1; i < chrono.length; i++) {
  const prev = chrono[i - 1]!;
  const cur = chrono[i]!;
  const delta = cur.drCr === "credit" ? cur.amount : -cur.amount;
  const expected = Math.round((prev.avlBal + delta) * 100) / 100;
  const ok = Math.abs(expected - cur.avlBal) < 0.001;
  if (!ok) {
    breaksChrono++;
    const impliedMissing =
      Math.round(
        (prev.avlBal - cur.avlBal - (cur.drCr === "debit" ? cur.amount : -cur.amount)) *
          100,
      ) / 100;
    const msg = `#${i + 1} ${cur.tsRaw} ref ${cur.refId}: after ${prev.avlBal} ${cur.drCr} ${cur.amount} expect ${expected}, got ${cur.avlBal} → missing ~Rs${Math.abs(impliedMissing)} ${impliedMissing > 0 ? "debit?" : "credit?"}`;
    chronoBreaks.push(msg);
    console.log("BREAK", msg);
  }
}
if (breaksChrono === 0) {
  console.log("Perfect chain — every SMS accounted for in time order.");
} else {
  console.log(`\n${breaksChrono} break(s) in chronological chain.`);
}

console.log("\n=== IMPLIED OPENING (before first credit in chrono) ===");
const first = chrono[0]!;
if (first.drCr === "credit") {
  console.log(
    `First txn credit ${first.amount} → bal ${first.avlBal}; implied opening Rs${(first.avlBal - first.amount).toFixed(2)}`,
  );
}

console.log("\n=== SUMMARY TABLE (chronological) ===");
console.log(
  "ts                  drCr    amount     avlBal     ref           counterparty",
);
for (const p of chrono) {
  console.log(
    `${p.tsRaw.padEnd(20)} ${p.drCr.padEnd(7)} ${String(p.amount).padStart(8)} ${String(p.avlBal).padStart(10)} ${p.refId} ${p.counterparty ?? "—"}`,
  );
}

const totalDr = debits.reduce((s, p) => s + p.amount, 0);
const totalCr = credits.reduce((s, p) => s + p.amount, 0);
console.log("\n=== TOTALS ===");
console.log(`Debits:  ${debits.length} txns, Rs${totalDr.toFixed(2)}`);
console.log(`Credits: ${credits.length} txns, Rs${totalCr.toFixed(2)}`);
console.log(`Net (credits - debits): Rs${(totalCr - totalDr).toFixed(2)}`);
if (chrono.length >= 2) {
  const open =
    chrono[0]!.drCr === "credit"
      ? chrono[0]!.avlBal - chrono[0]!.amount
      : chrono[0]!.avlBal + chrono[0]!.amount;
  const close = chrono[chrono.length - 1]!.avlBal;
  console.log(`Implied opening → closing: Rs${open.toFixed(2)} → Rs${close.toFixed(2)} (Δ ${(close - open).toFixed(2)})`);
}
