import { CAPABILITIES, refreshPaths } from "@/lib/ledger/capabilities";
import "server-only";
import { runCore, CoreFailure, ledgerToolError } from "./run-core";
import type { SettlementReceipt } from "@/lib/ledger/rules/settlement-policy";
import { and, eq } from "drizzle-orm";
import { Result, Schema } from "effect";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { LedgerError, type LedgerErrorCode, type WriteContext } from "@/lib/ledger/context";
import { requestHash, type Operation } from "@/lib/ledger/rules";
import { relationalSnapshot, relationalRows } from "@/lib/ledger/relational-store";
import { replayChange } from "@/lib/ledger/store";
import * as splits from "@/lib/ledger/splits";
import * as settlements from "@/lib/ledger/settlements";
import * as owed from "@/lib/ledger/owed-expenses";
import { saveNetEvent } from "@/lib/ledger/net-events";
import { linkPayeesToPerson } from "@/lib/ledger/person-links";
import { renamePayee } from "@/lib/ledger/metadata";
import { addStandingNote } from "@/lib/ledger/standing-notes";
import type { NetSettlementReceipt } from "@/lib/ledger/rules/net-settlement";
import type { NetEventLeg } from "@/lib/net-events/legs";
import { buildNetLegs } from "@/lib/net-events/build-legs";
import type { McpPrincipal } from "./auth";
import { RelationalInputs, RelationalOutput, type RelationalTool } from "./relational-schemas";
import { deriveMcpRefKey, deriveMcpRevKey, transactionRef, transactionRev, shareRef, owedRef, settlementRef, noteRef, splitRev } from "./refs";
import { mcpReadOps } from "./read-ops";
import { splitAmounts, moneyPaise, exactRupees, existingPerson, personKey } from "./write-rules";

type CoreResult = { value?: unknown; summary?: string; changeId: string | null; ops: readonly Operation[]; response?: Record<string, unknown>; replayed?: boolean };
function decode<K extends RelationalTool>(tool: K, raw: unknown): (typeof RelationalInputs)[K]["Type"] {
  const parsed = Schema.decodeUnknownResult(RelationalInputs[tool])(raw);
  if (Result.isFailure(parsed)) throw new LedgerError({ code: "invalid_input", message: "Use the tool's documented fields, exact decimal rupees and idempotency key." });
  return parsed.success;
}
const refuse = (code: LedgerErrorCode, message: string): never => { throw new LedgerError({ code, message }); };
const unavailable = (): never => refuse("not_found", "That ref isn't available in this account.");

/** Resolve only by recomputing refs over actor-scoped rows. All writes stay in ledger cores. */
export async function mcpRelationalWrite(p: McpPrincipal, tool: RelationalTool, raw: unknown): Promise<Record<string, unknown>> {
  if (p.scope !== "write") return { applied: false, errors: [{ code: "forbidden", message: "A write-scoped token is required." }] };
  let ctx: WriteContext | undefined;
  try {
    const common = decode(tool, raw);
    ctx = { actor: p.actor, source: "mcp", tokenId: p.tokenId, label: p.label, summary: common.reason,
      idempotency: { key: common.idempotency_key, requestHash: requestHash(tool, common) } };
    // Replay before mutable ref/name resolution, even after a deletion or secret rotation.
    const replay = await replayChange<CoreResult>(ctx);
    if (replay?.response) return { ...replay.response, replayed: true };
    const key = deriveMcpRefKey(process.env.AUTH_SECRET), revKey = deriveMcpRevKey(process.env.AUTH_SECRET);
    const txRef = (id: string) => transactionRef(key, p.actor.userId, id);
    const shRef = (id: string) => shareRef(key, p.actor.userId, p.actor.accountId, id);
    const owRef = (id: string) => owedRef(key, p.actor.userId, p.actor.accountId, id);
    const stRef = (id: string) => settlementRef(key, p.actor.userId, p.actor.accountId, id);
    const ntRef = (id: string) => noteRef(key, p.actor.userId, p.actor.accountId, id);
    const [snapshot, txns] = await Promise.all([
      relationalSnapshot(db, ctx), mcpReadOps.listTransactions(p.actor, {}),
    ]);
    ctx.expectedRelations = snapshot;
    const before = relationalRows(snapshot);
    const names = [...before.people.map(row => row.name), ...before.participants.map(row => row.personName), ...before.owed.map(row => row.personName)];
    const person = (name: string, create = false, distinctFrom: readonly string[] = []) => existingPerson(names, name, create, distinctFrom);
    const txn = (ref: string, rev?: string) => {
      const row = txns.find(row => txRef(row.id) === ref) ?? unavailable();
      const current = transactionRev(revKey, p.actor.userId, row.id, row);
      if (rev !== undefined && rev !== current) throw new LedgerError({ code: "stale", message: "Read the transaction again before writing.", current_rev: current });
      ctx!.transactionRevs = { ...ctx!.transactionRevs, [row.id]: rev ?? current };
      return row;
    };
    const guardSplit = (transactionId: string, expected: string | undefined) => {
      if (expected === undefined) return;
      ctx!.splitRevs = { [transactionId]: expected };
      const split = before.splits.find(row => row.transactionId === transactionId);
      const current = splitRev(revKey, p.actor.userId, transactionId, split, before.participants.filter(row => row.splitId === split?.id));
      if (expected !== current) throw new LedgerError({ code: "stale", message: "The split changed. Read it again before writing.", current_split_rev: current });
    };
    const share = (ref: string) => before.participants.find(row => shRef(row.id) === ref) ?? unavailable();
    const expense = (ref: string) => before.owed.find(row => owRef(row.id) === ref) ?? unavailable();
    const settlement = (ref: string) => before.settlements.find(row => stRef(row.id) === ref) ?? unavailable();
    const settled = (id: string) => before.settlements.filter(row => row.splitParticipantId === id).reduce((n, row) => n + row.amountPaise, 0);
    const baseRefs: string[] = [];
    let summary = "", details: Partial<typeof RelationalOutput.Type> = {};
    const render = (value: CoreResult): Record<string, unknown> => {
      if (tool === "record_settlement" && value.value) {
        const receipt = value.value as SettlementReceipt;
        details = { allocations: receipt.applied.map(row => ({ share_ref: shRef(row.splitParticipantId), person: row.personName, amount: exactRupees(row.amountPaise), left: exactRupees(row.leftPaise) })), unallocated: exactRupees(receipt.unallocatedPaise), left_open: exactRupees(receipt.stillOpenPaise), leftover: receipt.leftover ? { kind: receipt.leftover.kind, amount: exactRupees(receipt.leftover.paise) } : null };
        summary = `Recorded ₹${exactRupees(receipt.appliedPaise)} from ${decode("record_settlement", raw).person}; ₹${exactRupees(receipt.stillOpenPaise)} still open and ₹${exactRupees(receipt.unallocatedPaise)} unallocated${receipt.leftover ? `; ₹${exactRupees(receipt.leftover.paise)} marked ${receipt.leftover.kind.replace("_", " ")}` : ""}.`;
      }
      if (tool === "net_settle" && value.value) {
        const { receipt } = value.value as { receipt: NetSettlementReceipt };
        details = { receipt: { date: receipt.eventDate, bank_inflow: exactRupees(receipt.bankInflowPaise), bank_outflow: exactRupees(receipt.bankOutflowPaise),
          legs: receipt.legs.map(l => ({ kind: l.kind, ref: 'splitParticipantId' in l.target ? shRef(l.target.splitParticipantId) : owRef(l.target.owedExpenseId), method: l.method, amount: exactRupees(l.amountPaise), left: exactRupees(l.leftPaise) })) } };
      }
      const refs = new Set(baseRefs);
      for (const op of value.ops) {
        if (op.target === "participant") refs.add(shRef(op.id));
        else if (op.target === "settlement") refs.add(stRef(op.id));
        else if (op.target === "owed_expense") refs.add(owRef(op.id));
        else if (op.target === "standing_note") refs.add(ntRef(op.id));
        else if (op.target === "transaction_residual" || op.target === "transaction") refs.add(txRef(op.id));
        else if (op.target === "split") refs.add(txRef((op.after ?? op.before)!.row.transactionId));
      }
      return Schema.decodeUnknownSync(RelationalOutput)({ applied: true, change_id: value.changeId, summary: value.summary ?? summary, refs: [...refs], ...details });
    };
    ctx.idempotency!.renderResult = value => render(value as CoreResult);
    let result: CoreResult;
    switch (tool) {
      case "link_person": {
        const input = decode(tool, raw);
        const payees = await db.select({ id: schema.counterparties.id, key: schema.counterparties.key }).from(schema.counterparties)
          .where(eq(schema.counterparties.userId, p.actor.userId));
        const links = input.links.map(link => {
          const bank = link.ref ? txn(link.ref) : undefined;
          const key = bank?.counterpartyKey ?? link.payee;
          const payee = payees.find(row => row.key === key) ?? unavailable();
          const refs = txns.filter(row => row.counterpartyKey === payee.key).map(row => txRef(row.id));
          if (!refs.length) unavailable();
          baseRefs.push(...refs);
          return { counterpartyId: payee.id, person: link.person, currentPerson: link.current_person, ...(link.create_person !== undefined ? { createPerson: link.create_person } : {}), ...(link.distinct_from !== undefined ? { distinctFrom: link.distinct_from } : {}) };
        });
        result = await linkPayeesToPerson(ctx, links);
        summary = result.summary ?? "Updated person links.";
        break;
      }
      case "create_split": {
        const input = decode(tool, raw), bill = txn(input.ref, input.rev);
        guardSplit(bill.id, input.split_rev);
        if (bill.drCr !== "debit") refuse("invalid_source", "Only a debit payment can be split.");
        const participants = input.participants.map(row => ({ personName: person(row.person, row.create_person, row.distinct_from), amount: row.amount }));
        if (new Set(participants.map(row => personKey(row.personName))).size !== participants.length) refuse("duplicate_person", "Each person may have only one share.");
        const amounts = splitAmounts(bill.amountPaise, participants.map(row => row.amount), input.your_share, input.equal === true);
        const existing = before.splits.find(row => row.transactionId === bill.id);
        if (existing && !input.replace_existing) refuse("existing_split", "This payment already has a split. Confirm replace_existing:true before replacing it.");
        const settledNames = existing ? before.participants.filter(row => row.splitId === existing.id && before.settlements.some(s => s.splitParticipantId === row.id)).map(row => row.personName) : [];
        if (settledNames.length) refuse("settled_split", `Cannot replace: shares for ${settledNames.join(", ")} have settlements. Clear them first.`);
        summary = `Split ₹${exactRupees(bill.amountPaise)} with ${participants.map(row => row.personName).join(", ")}; your share ₹${exactRupees(amounts.yours)}.`;
        baseRefs.push(input.ref);
        result = await splits.createSplit(ctx, { transactionId: bill.id, totalPaise: bill.amountPaise, yourSharePaise: amounts.yours, note: input.note ?? null,
          expectNoExistingSplit: !input.replace_existing, participants: participants.map((row, i) => ({ personName: row.personName, expectedAmountPaise: amounts.participants[i] })) });
        break;
      }
      case "delete_split": {
        const input = decode(tool, raw), bill = txn(input.ref, input.rev);
        guardSplit(bill.id, input.split_rev);
        baseRefs.push(input.ref); summary = "Deleted split and its unsettled shares.";
        result = await splits.deleteSplit(ctx, { transactionId: bill.id, expectNoSettlements: true }); break;
      }
      case "record_settlement": {
        const input = decode(tool, raw), inflow = txn(input.inflow_ref), name = person(input.person);
        if (input.allocations?.length === 0 && !input.leftover) refuse("invalid_input", "Give at least one allocation, or a leftover to mark.");
        const allocations: splits.RecordSettlementInput["allocations"] = input.allocations ? { kind: "explicit", rows: input.allocations.map(row => {
          if ("owed_ref" in row) { expense(row.owed_ref); return refuse("invalid_target", "An owed expense is money you owe; an incoming credit cannot repay it. Use net_settle for offsets."); }
          const target = share(row.share_ref);
          if (personKey(target.personName) !== personKey(name)) refuse("not_found", "That share isn't available for this person.");
          return { splitParticipantId: target.id, amountPaise: moneyPaise(row.amount) };
        }) } : { kind: "oldest_first", personName: name };
        baseRefs.push(input.inflow_ref);
        result = await runCore(splits.recordSettlement(ctx, { inflowTransactionId: inflow.id, mode: "append", allocations,
          ...(input.leftover ? { residual: { kind: input.leftover.kind, personName: name, note: input.leftover.note ?? null } } : {}) }), p);
        break;
      }

      case "clear_settlement": {
        const input = decode(tool, raw), inflow = txn(input.inflow_ref);
        baseRefs.push(input.inflow_ref); summary = "Cleared ordinary bank allocations and the leftover explanation; net-event legs remain.";
        result = await splits.clearSettlement(ctx, { inflowTransactionId: inflow.id }); break;
      }
      case "record_cash_settlement": {
        const input = decode(tool, raw), target = share(input.share_ref), amountPaise = moneyPaise(input.amount);
        baseRefs.push(input.share_ref); summary = `Recorded ₹${exactRupees(amountPaise)} cash from ${target.personName}.`;
        result = await runCore(settlements.recordCashSettlement(ctx, { splitParticipantId: target.id, amountPaise, note: input.note ?? null }), p); break;
      }
      case "write_off_share": {
        const input = decode(tool, raw), target = share(input.share_ref);
        baseRefs.push(input.share_ref); summary = `Forgave ${target.personName}'s outstanding ₹${exactRupees(Math.max(0, target.expectedAmountPaise - settled(target.id)))}.`;
        result = await settlements.writeOffParticipantShare(ctx, { splitParticipantId: target.id, note: input.note ?? null }); break;
      }
      case "undo_write_off": {
        const input = decode(tool, raw), target = settlement(input.settlement_ref);
        baseRefs.push(input.settlement_ref); summary = "Reversed share writeoff.";
        result = await settlements.undoWriteOff(ctx, { settlementId: target.id }); break;
      }
      case "net_settle": {
        const input = decode(tool, raw);
        const inflow = input.inflow_ref ? txn(input.inflow_ref) : undefined, outflow = input.outflow_ref ? txn(input.outflow_ref) : undefined;
        for (const bank of [inflow, outflow]) if (bank) baseRefs.push(txRef(bank.id));
        const receivables = input.receivables.map(row => { const target = share(row.share_ref); baseRefs.push(row.share_ref); return { id: target.id, paise: moneyPaise(row.amount) }; });
        const payables = input.payables.map(row => { const target = expense(row.owed_ref); baseRefs.push(row.owed_ref); return { id: target.id, paise: moneyPaise(row.amount) }; });
        for (const lines of [receivables, payables]) {
          if (lines.reduce((sum, line) => sum + BigInt(line.paise), 0n) > BigInt(Number.MAX_SAFE_INTEGER))
            refuse("invalid_amount", "Combined net allocations exceed the exact paise range.");
        }
        summary = "Recorded net settlement.";
        for (const [rows, ids] of [[input.receivables, receivables], [input.payables, payables]] as const) {
          const guards = new Map<string, number>();
          rows.forEach((row, i) => {
            const expected = moneyPaise(row.expected_outstanding), id = ids[i].id;
            if (guards.has(id) && guards.get(id) !== expected) refuse("invalid_input", "Conflicting balance previews for the same bill.");
            guards.set(id, expected);
          });
        }
        const built = buildNetLegs({ receivables, payables, inflowTransactionId: inflow?.id, inflowAmountPaise: inflow?.amountPaise ?? 0 });
        const explicit = input.receivables.some(r => r.method) || input.payables.some(r => r.method);
        if (explicit && [...input.receivables, ...input.payables].some(r => !r.method)) refuse("invalid_input", "Supply method on every leg when using explicit methods.");
        const legs: NetEventLeg[] = explicit ? [
          ...input.receivables.map((r, i): NetEventLeg => ({ kind: "receivable", splitParticipantId: receivables[i].id, amountPaise: receivables[i].paise, method: r.method!, expectedOutstandingPaise: moneyPaise(r.expected_outstanding) })),
          ...input.payables.map((r, i): NetEventLeg => ({ kind: "payable", owedExpenseId: payables[i].id, amountPaise: payables[i].paise, method: r.method!, expectedOutstandingPaise: moneyPaise(r.expected_outstanding) })),
        ] : built.map(l => ({ ...l, expectedOutstandingPaise: moneyPaise(l.kind === "receivable" ? input.receivables.find(r => share(r.share_ref).id === l.splitParticipantId)!.expected_outstanding : input.payables.find(r => expense(r.owed_ref).id === l.owedExpenseId)!.expected_outstanding) }));
        result = await runCore(saveNetEvent(ctx, { eventDate: input.date, inflowTransactionId: inflow?.id, outflowTransactionId: outflow?.id, note: input.note, legs }), p); break;
      }
      case "add_owed_expense": {
        const input = decode(tool, raw), name = person(input.person, input.create_person, input.distinct_from), amountPaise = moneyPaise(input.amount);
        const source = input.source_inflow_ref ? txn(input.source_inflow_ref) : undefined;
        if (source) baseRefs.push(txRef(source.id));
        summary = `Added ₹${exactRupees(amountPaise)} owed to ${name} for ${input.what.trim()}.`;
        result = await owed.createOwedExpense(ctx, { personName: name, incurredDate: input.date, description: input.what, amountPaise, note: input.note, sourceInflowTransactionId: source?.id }); break;
      }
      case "update_owed_expense": {
        const input = decode(tool, raw), target = expense(input.owed_ref);
        if ([input.person, input.date, input.what, input.amount, input.note].every(v => v === undefined)) refuse("no_fields", "Supply a person, date, what, amount or note to update.");
        baseRefs.push(input.owed_ref); summary = `Updated owed expense for ${target.personName}.`;
        result = await owed.updateOwedExpense(ctx, { id: target.id, personName: input.person !== undefined ? person(input.person) : undefined, incurredDate: input.date, description: input.what,
          amountPaise: input.amount !== undefined ? moneyPaise(input.amount) : undefined, note: input.note }); break;
      }
      case "delete_owed_expense": {
        const input = decode(tool, raw), target = expense(input.owed_ref);
        baseRefs.push(input.owed_ref); summary = `Deleted ₹${exactRupees(target.amountPaise)} owed to ${target.personName} and dependent settlements.`;
        result = await owed.deleteOwedExpense(ctx, { id: target.id }); break;
      }
      case "rename_payee": {
        const input = decode(tool, raw), target = txn(input.ref);
        const [row] = await db.select({ counterpartyId: schema.transactions.counterpartyId }).from(schema.transactions).where(and(eq(schema.transactions.id, target.id), eq(schema.transactions.accountId, p.actor.accountId)));
        const counterpartyId = row?.counterpartyId ?? refuse("no_payee", "That transaction has no payee.");
        baseRefs.push(input.ref); summary = `Renamed payee to ${input.display_name.trim()}.`;
        result = await renamePayee(ctx, { counterpartyId, displayName: input.display_name, currentDisplayName: input.current_display_name }); break;
      }
      case "add_standing_note": {
        const input = decode(tool, raw); summary = "Added standing note.";
        result = await runCore(addStandingNote(ctx, input.body), p); break;
      }
    }
    const capability = CAPABILITIES.find(c => "tools" in c.mcp && c.mcp.tools.some(t => t.name === tool));
    if (!capability) throw new Error(`Unregistered relational tool: ${tool}`);
    for (const path of refreshPaths(capability.id)) revalidatePath(path);
    return result.response ?? render(result);
  } catch (e) {
    // A concurrent identical request may have committed after the first replay check.
    const replay = ctx ? await replayChange<CoreResult>(ctx) : null;
    if (replay?.response) return { ...replay.response, replayed: true };
    if (e instanceof CoreFailure) return { applied: false, errors: [e.error] };
    if (e instanceof LedgerError) return { applied: false, errors: [ledgerToolError(e)] };
    if (e instanceof ForbiddenError) return { applied: false, errors: [{ code: "not_found", message: "That ref isn't available in this account." }] };
    // Anything else is a defect: rethrow so the server returns its generic message instead of internal text.
    throw e;
  }
}
