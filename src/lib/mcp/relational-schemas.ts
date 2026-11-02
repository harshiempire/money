import { Schema } from "effect";
import { Day } from "./schemas";
import { IdempotencyKey, WriteError } from "./write-schemas";
import { Money, PositiveMoney } from "./write-rules";

const text = (max: number, description: string) => Schema.String.check(Schema.isMaxLength(max), Schema.makeFilter(s => s.trim().length > 0)).annotate({ description });
const ref = (description: string) => Schema.NonEmptyString.annotate({ description });
const common = { idempotency_key: IdempotencyKey, reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200)).annotate({ description: "Short reason saved in Recent changes, at most 200 characters." })) };
const note = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200)).annotate({ description: "Optional note, at most 200 characters." }));
const person = text(200, "Exact existing person name, case-insensitive after trim; unknown names return close names.");
const txn = ref("Opaque txn_ ref from Money read tools.");
const share = ref("Opaque shr_ ref from get_open_balances or get_transactions.");
const owed = ref("Opaque owe_ ref from get_open_balances or get_transactions.");
const settlement = ref("Opaque stl_ ref from get_transactions or query.");
const rev = ref("Current transaction rev from Money read tools. Stale errors include current_rev.");
const rows = <S extends Schema.Top>(s: S) => Schema.Array(s).check(Schema.isBetweenLength(1, 100));
export const RelationalInputs = {
  create_split: Schema.Struct({ ...common, ref: txn, rev,
    participants: rows(Schema.Struct({ person, amount: Schema.optionalKey(Money), create_person: Schema.optionalKey(Schema.Boolean.annotate({ description: "Explicitly allow creating this person when no exact existing name matches." })) })),
    your_share: Schema.optionalKey(Money), equal: Schema.optionalKey(Schema.Boolean),
    replace_existing: Schema.optionalKey(Schema.Boolean.annotate({ description: "Explicit confirmation to replace an existing split; never allowed with settled shares." })), note }),
  delete_split: Schema.Struct({ ...common, ref: txn, rev }),
  record_settlement: Schema.Struct({ ...common, inflow_ref: txn, person,
    allocations: Schema.optionalKey(rows(Schema.Union([
      Schema.Struct({ share_ref: share, amount: PositiveMoney }),
      Schema.Struct({ owed_ref: owed, amount: PositiveMoney }),
    ]))) }),
  clear_settlement: Schema.Struct({ ...common, inflow_ref: txn }),
  // The existing cash core stores the server date, with no backdating support.
  record_cash_settlement: Schema.Struct({ ...common, share_ref: share, amount: PositiveMoney, note }),
  write_off_share: Schema.Struct({ ...common, share_ref: share, note }),
  undo_write_off: Schema.Struct({ ...common, settlement_ref: settlement }),
  net_settle: Schema.Struct({ ...common,
    date: Day.annotate({ description: "Net event date, YYYY-MM-DD." }),
    inflow_ref: Schema.optionalKey(txn), outflow_ref: Schema.optionalKey(txn),
    receivables: Schema.Array(Schema.Struct({ share_ref: share, amount: PositiveMoney })).check(Schema.isMaxLength(100)),
    payables: Schema.Array(Schema.Struct({ owed_ref: owed, amount: PositiveMoney })).check(Schema.isMaxLength(100)), note }),
  add_owed_expense: Schema.Struct({ ...common, person, create_person: Schema.optionalKey(Schema.Boolean),
    date: Day, what: text(500, "What the owner owes for."), amount: PositiveMoney,
    source_inflow_ref: Schema.optionalKey(txn), note }),
  update_owed_expense: Schema.Struct({ ...common, owed_ref: owed,
    person: Schema.optionalKey(person), date: Schema.optionalKey(Day), what: Schema.optionalKey(text(500, "Replacement expense description.")), amount: Schema.optionalKey(PositiveMoney), note }),
  delete_owed_expense: Schema.Struct({ ...common, owed_ref: owed }),
  rename_payee: Schema.Struct({ ...common, ref: txn, display_name: text(200, "New payee display name; all payments for this payee use it."),
    current_display_name: Schema.NullOr(Schema.String).annotate({ description: "Exact current display name (null when unset), confirming replacement." }) }),
  add_standing_note: Schema.Struct({ ...common, body: text(500, "Full standing note, unredacted; at most 500 characters, 40 notes per owner.") }),
};
export type RelationalTool = keyof typeof RelationalInputs;
export const RelationalOutput = Schema.Struct({
  applied: Schema.Boolean,
  change_id: Schema.optionalKey(Schema.NullOr(Schema.String).annotate({ description: "Change id for undo_change and Recent changes; null for a no-op." })),
  summary: Schema.optionalKey(Schema.String.annotate({ description: "Short human-readable result naming affected people and money." })),
  refs: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Affected opaque transaction, share, owed, settlement or note refs; never database ids." })),
  allocations: Schema.optionalKey(Schema.Array(Schema.Struct({ share_ref: Schema.String, person: Schema.String, amount: Schema.String, left: Schema.String })).annotate({ description: "Allocations added by this request, exact rupees and each share's remaining balance." })),
  unallocated: Schema.optionalKey(Schema.String.annotate({ description: "Rupees remaining unallocated on the credit after this request." })),
  left_open: Schema.optionalKey(Schema.String.annotate({ description: "Total still owed to the owner by the named person, in exact rupees." })),
  errors: Schema.optionalKey(Schema.Array(WriteError)), replayed: Schema.optionalKey(Schema.Boolean),
});
export const RelationalDescriptions: Record<RelationalTool, string> = {
  create_split: "Split a debit equally among you and named participants (odd paise go to you), or provide every amount and your_share exactly. Unknown people require create_person:true. Refuses stale revs, an existing split without replace_existing:true, or replacement with any settled share. Undo with undo_change; new settlements can prevent undo.",
  delete_split: "Delete a debit's split with its current rev. Refuses stale revs and any settlement, cash or writeoff on any share. Undo with undo_change restores the exact split and shares.",
  record_settlement: "Allocate a credit to an exact existing person's open shares, oldest bill first then creation order, with a partial final share. Explicit share_ref allocations override that order and must fit both outstanding shares and unallocated inflow. Earlier allocations are preserved. owed_ref is refused: owed expenses are money you owe, not incoming repayments. Refuses debits, fully allocated or explained inflows, net-event inflows and stale balances. Undo with undo_change.",
  clear_settlement: "Clear an inflow's ordinary bank allocations and leftover explanation. Refuses removal of a leftover payable already repaid; net-event legs remain. Undo with undo_change restores allocations and the explanation if unchanged.",
  record_cash_settlement: "Record positive cash against an open share using the server's current date; backdating is unsupported. Refuses amounts exceeding outstanding and stale balances. Undo with undo_change.",
  write_off_share: "Forgive the entire outstanding share, recording a writeoff. Refuses a fully settled share or stale balances. Undo with undo_write_off using the returned stl_ ref, or undo_change.",
  undo_write_off: "Remove a writeoff using its stl_ ref. Refuses missing, foreign or non-writeoff settlements and stale balances. Undo this removal with undo_change.",
  net_settle: "Create a net settlement using the app's rules: receivables minus payables must equal inflow minus outflow exactly. Bank legs use the inflow first, then offsets. Use existing share_ref and owed_ref lines; add a new payable with add_owed_expense first. Refuses wrong bank direction, existing net events or explained bank rows, over-allocation (including repeated lines), empty or stale balances. Undo with undo_change.",
  add_owed_expense: "Add money you owe a named person, with date, description and exact amount. Unknown people require create_person:true. Optional source_inflow_ref must be a credit with sufficient unexplained money and no prior explanation or net event. Refuses invalid amounts and stale balances. Undo with undo_change; later repayments can prevent undo.",
  update_owed_expense: "Edit an owed expense's person, date, description, amount or note. Refuses unknown refs or people, empty edits, stale balances and reducing the amount below existing settlements. Undo with undo_change.",
  delete_owed_expense: "Delete an owed expense and its dependent settlements, as in the app. Refuses unknown or foreign refs and stale balances. Undo with undo_change restores the expense and repayments if dependencies remain unchanged.",
  rename_payee: "Rename the payee of any transaction ref. current_display_name must exactly confirm the present display name (null if unset). Refuses missing payees, blank names and a changed current name. Undo with undo_change; it refuses a later rename.",
  add_standing_note: "Save a full unredacted standing note, up to 500 characters and 40 notes per owner, using the app's trim rules. Refuses blank notes, the note cap and missing notes migration. Undo with undo_change; later note edits prevent undo.",
};
