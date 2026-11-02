import "server-only";
import { and, eq } from "drizzle-orm";
import { Result, Schema } from "effect";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { ForbiddenError } from "@/lib/auth/forbidden";
import { LedgerError, type WriteContext } from "@/lib/ledger/context";
import { requestHash, type Operation } from "@/lib/ledger/rules";
import { relationalSnapshot, relationalRows } from "@/lib/ledger/relational-store";
import { replayChange } from "@/lib/ledger/store";
import * as splits from "@/lib/ledger/splits";
import * as settlements from "@/lib/ledger/settlements";
import * as owed from "@/lib/ledger/owed-expenses";
import { saveNetEvent } from "@/lib/ledger/net-events";
import { renamePayee, addStandingNote } from "@/lib/ledger/metadata";
import { NetEventValidationError } from "@/lib/net-events/errors";
import { buildNetLegs } from "@/lib/net-events/build-legs";
import type { McpPrincipal } from "./auth";
import { RelationalInputs, RelationalOutput, type RelationalTool } from "./relational-schemas";
import { deriveMcpRefKey, deriveMcpRevKey, transactionRef, transactionRev, shareRef, owedRef, settlementRef, noteRef } from "./refs";
import { mcpReadOps } from "./read-ops";
import { allocateOldestFirst, validateAllocations, splitAmounts, moneyPaise, exactRupees, existingPerson, personKey } from "./write-rules";

type CoreResult = { changeId: string | null; ops: readonly Operation[]; response?: Record<string, unknown>; replayed?: boolean };
function decode<K extends RelationalTool>(tool: K, raw: unknown): (typeof RelationalInputs)[K]["Type"] {
  const parsed = Schema.decodeUnknownResult(RelationalInputs[tool])(raw);
  if (Result.isFailure(parsed)) throw new LedgerError({ code: "invalid_input", message: "Use the tool's documented fields, exact decimal rupees and idempotency key." });
  return parsed.success;
}
const refuse = (code: string, message: string): never => { throw new LedgerError({ code, message }); };
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
    const person = (name: string, create = false) => existingPerson(names, name, create);
    const txn = (ref: string, rev?: string) => {
      const row = txns.find(row => txRef(row.id) === ref) ?? unavailable();
      const current = transactionRev(revKey, p.actor.userId, row.id, row);
      if (rev !== undefined && rev !== current) throw new LedgerError({ code: "stale", message: "Read the transaction again before writing.", current_rev: current });
      ctx!.transactionRevs = { ...ctx!.transactionRevs, [row.id]: rev ?? current };
      return row;
    };
    const share = (ref: string) => before.participants.find(row => shRef(row.id) === ref) ?? unavailable();
    const expense = (ref: string) => before.owed.find(row => owRef(row.id) === ref) ?? unavailable();
    const settlement = (ref: string) => before.settlements.find(row => stRef(row.id) === ref) ?? unavailable();
    const settled = (id: string) => before.settlements.filter(row => row.splitParticipantId === id).reduce((n, row) => n + row.amountPaise, 0);
    const openShares = (name: string) => before.participants.filter(row => personKey(row.personName) === personKey(name)).map(row => {
      const split = before.splits.find(s => s.id === row.splitId)!;
      const bill = txns.find(t => t.id === split.transactionId)!;
      return { id: row.id, date: bill.txnDate, order: split.createdAt, leftPaise: Math.max(0, row.expectedAmountPaise - settled(row.id)) };
    });
    const baseRefs: string[] = [];
    let summary = "", details: Partial<typeof RelationalOutput.Type> = {};
    const render = (value: CoreResult): Record<string, unknown> => {
      const refs = new Set(baseRefs);
      for (const op of value.ops) {
        if (op.target === "participant") refs.add(shRef(op.id));
        else if (op.target === "settlement") refs.add(stRef(op.id));
        else if (op.target === "owed_expense") refs.add(owRef(op.id));
        else if (op.target === "standing_note") refs.add(ntRef(op.id));
        else if (op.target === "transaction_residual" || op.target === "transaction") refs.add(txRef(op.id));
        else if (op.target === "split") refs.add(txRef((op.after ?? op.before)!.row.transactionId));
      }
      return Schema.decodeUnknownSync(RelationalOutput)({ applied: true, change_id: value.changeId, summary, refs: [...refs], ...details });
    };
    ctx.idempotency!.renderResult = value => render(value as CoreResult);
    let result: CoreResult;
    switch (tool) {
      case "create_split": {
        const input = decode(tool, raw), bill = txn(input.ref, input.rev);
        if (bill.drCr !== "debit") refuse("invalid_source", "Only a debit payment can be split.");
        const participants = input.participants.map(row => ({ personName: person(row.person, row.create_person), amount: row.amount }));
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
        baseRefs.push(input.ref); summary = "Deleted split and its unsettled shares.";
        result = await splits.deleteSplit(ctx, { transactionId: bill.id, expectNoSettlements: true }); break;
      }
      case "record_settlement": {
        const input = decode(tool, raw), inflow = txn(input.inflow_ref), name = person(input.person);
        if (inflow.drCr !== "credit") refuse("invalid_source", "Only an incoming credit can settle shares.");
        const used = before.settlements.filter(row => row.inflowTransactionId === inflow.id);
        const net = [...snapshot.values()].some(op => op.target === "net_event" && (op.after?.row.inflowTransactionId === inflow.id || op.after?.row.outflowTransactionId === inflow.id));
        if (net || used.some(row => row.netEventId)) refuse("net_event", "This inflow is part of a net event; undo that event first.");
        if (before.owed.some(row => row.sourceInflowTransactionId === inflow.id)) refuse("explained_inflow", "This inflow already has an owed-expense explanation. Clear it first.");
        const residual = snapshot.get(`transaction_residual:${inflow.id}`);
        if (residual?.target === "transaction_residual" && residual.after?.row.residualDisposition) refuse("explained_inflow", "This inflow's leftover is already acknowledged. Clear its settlement first.");
        const available = inflow.amountPaise - used.reduce((n, row) => n + row.amountPaise, 0);
        if (available <= 0) refuse("fully_allocated", "This inflow is already fully allocated.");
        const open = openShares(name);
        const allocated = input.allocations ? validateAllocations(available, open, input.allocations.map(row => {
          if ("owed_ref" in row) { expense(row.owed_ref); return refuse("invalid_target", "An owed expense is money you owe; an incoming credit cannot repay it. Use net_settle for offsets."); }
          const target = share(row.share_ref);
          return { id: target.id, amountPaise: moneyPaise(row.amount) };
        })) : allocateOldestFirst(available, open);
        if (!allocated.allocations.length) refuse("no_open_shares", `No open shares for ${name}.`);
        const left = open.reduce((n, row) => n + BigInt(row.leftPaise), 0n) - allocated.allocations.reduce((n, row) => n + BigInt(row.amountPaise), 0n);
        details = { allocations: allocated.allocations.map(row => ({ share_ref: shRef(row.id), person: name, amount: exactRupees(row.amountPaise), left: exactRupees(row.leftPaise) })),
          unallocated: exactRupees(allocated.remaining), left_open: exactRupees(left) };
        summary = `Recorded ₹${exactRupees(available - allocated.remaining)} from ${name}; ₹${exactRupees(left)} still open and ₹${exactRupees(allocated.remaining)} unallocated.`;
        baseRefs.push(input.inflow_ref, ...allocated.allocations.map(row => shRef(row.id)));
        // The app core replaces allocations: preserve this inflow's previous plain rows.
        result = await splits.recordSettlement(ctx, { inflowTransactionId: inflow.id, allocations: [
          ...used.map(row => ({ splitParticipantId: row.splitParticipantId!, amountPaise: row.amountPaise })),
          ...allocated.allocations.map(row => ({ splitParticipantId: row.id, amountPaise: row.amountPaise })),
        ] }); break;
      }
      case "clear_settlement": {
        const input = decode(tool, raw), inflow = txn(input.inflow_ref);
        baseRefs.push(input.inflow_ref); summary = "Cleared ordinary bank allocations and the leftover explanation; net-event legs remain.";
        result = await splits.clearSettlement(ctx, { inflowTransactionId: inflow.id }); break;
      }
      case "record_cash_settlement": {
        const input = decode(tool, raw), target = share(input.share_ref), amountPaise = moneyPaise(input.amount);
        const left = Math.max(0, target.expectedAmountPaise - settled(target.id));
        if (amountPaise > left) refuse("over_allocation", `Cash exceeds the outstanding ₹${exactRupees(left)}.`);
        baseRefs.push(input.share_ref); summary = `Recorded ₹${exactRupees(amountPaise)} cash from ${target.personName}.`;
        result = await settlements.recordCashSettlement(ctx, { splitParticipantId: target.id, amountPaise, note: input.note ?? null }); break;
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
        if (inflow && inflow.drCr !== "credit" || outflow && outflow.drCr !== "debit") refuse("invalid_source", "Net inflow must be a credit and outflow a debit.");
        for (const bank of [inflow, outflow]) {
          if (!bank) continue;
          if (before.settlements.some(row => row.inflowTransactionId === bank.id) || before.owed.some(row => row.sourceInflowTransactionId === bank.id)) refuse("explained_inflow", "A bank row already has allocations or a sourced owed expense. Clear that explanation first.");
          const residual = snapshot.get(`transaction_residual:${bank.id}`);
          if (residual?.target === "transaction_residual" && residual.after?.row.residualDisposition) refuse("explained_inflow", "A bank row already has an acknowledged leftover. Clear it first.");
          baseRefs.push(txRef(bank.id));
        }
        const receivables = input.receivables.map(row => { const target = share(row.share_ref); baseRefs.push(row.share_ref); return { id: target.id, paise: moneyPaise(row.amount) }; });
        const payables = input.payables.map(row => { const target = expense(row.owed_ref); baseRefs.push(row.owed_ref); return { id: target.id, paise: moneyPaise(row.amount) }; });
        for (const lines of [receivables, payables]) {
          if (lines.reduce((sum, line) => sum + BigInt(line.paise), 0n) > BigInt(Number.MAX_SAFE_INTEGER))
            refuse("invalid_amount", "Combined net allocations exceed the exact paise range.");
        }
        summary = "Recorded net settlement using bank and offset legs.";
        result = await saveNetEvent(ctx, { eventDate: input.date, inflowTransactionId: inflow?.id, outflowTransactionId: outflow?.id, note: input.note,
          legs: buildNetLegs({ receivables, payables, inflowTransactionId: inflow?.id, inflowAmountPaise: inflow?.amountPaise ?? 0 }) }); break;
      }
      case "add_owed_expense": {
        const input = decode(tool, raw), name = person(input.person, input.create_person), amountPaise = moneyPaise(input.amount);
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
        result = await addStandingNote(ctx, input.body); break;
      }
    }
    for (const path of ["/", "/transactions", "/reimbursements", "/people", "/spend", "/connections"]) revalidatePath(path);
    return result.response ?? render(result);
  } catch (e) {
    // A concurrent identical request may have committed after the first replay check.
    const replay = ctx ? await replayChange<CoreResult>(ctx) : null;
    if (replay?.response) return { ...replay.response, replayed: true };
    if (e instanceof LedgerError) return { applied: false, errors: [{ code: e.code, message: e.message, ...(e.current_rev ? { current_rev: e.current_rev } : {}) }] };
    if (e instanceof ForbiddenError) return { applied: false, errors: [{ code: "not_found", message: "That ref isn't available in this account." }] };
    if (e instanceof NetEventValidationError || e instanceof Error && e.name === "Error" && !e.cause)
      return { applied: false, errors: [{ code: e instanceof NetEventValidationError ? e.code.toLowerCase() : "invalid_input", message: e.message }] };
    throw e;
  }
}
