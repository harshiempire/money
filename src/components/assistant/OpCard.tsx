"use client";

import { formatPaise, formatPaisePlain, formatPaiseSigned } from "@/lib/format";
import {
  equalShares,
  fillReceivablesLargestFirst,
  netBalance,
  rupeesString,
  splitBalance,
  typedPaise,
} from "@/lib/assistant/card-math";
import type { CategoryLite, ChatMessage, NetLine, OpDraft, TxnCardData } from "@/lib/assistant/types";
import { draftReady } from "./ops";
import { card, ghostButton, input, label, outlineButton, primaryButton, prettyDate } from "./ui";

type OpMessage = Extract<ChatMessage, { kind: "op" }>;

const STATUS = {
  pending: { chip: "Pending", chipClass: "border-amber-500 text-amber-700 dark:border-amber-700 dark:text-amber-300" },
  applying: { chip: "Saving…", chipClass: "border-amber-500 text-amber-700 dark:border-amber-700 dark:text-amber-300" },
  applied: { chip: "Applied", chipClass: "border-emerald-500 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300" },
  undoing: { chip: "Undoing…", chipClass: "border-neutral-400 text-neutral-500 dark:border-neutral-700" },
  discarded: { chip: "Discarded", chipClass: "border-neutral-400 text-neutral-500 dark:border-neutral-700" },
  undone: { chip: "Undone", chipClass: "border-neutral-400 text-neutral-500 dark:border-neutral-700" },
} as const;

const TITLE: Record<OpDraft["op"], string> = {
  split: "Create split",
  note: "Add note",
  cat: "Set category",
  cat_all: "Apply to all from payee",
  net: "Net settle",
};

export function OpCard({
  msg,
  txn,
  categories,
  onChange,
  onApply,
  onDiscard,
  onUndo,
}: {
  msg: OpMessage;
  txn: TxnCardData | undefined;
  categories: CategoryLite[];
  onChange: (draft: OpDraft) => void;
  onApply: () => void;
  onDiscard: () => void;
  onUndo: () => void;
}) {
  const { draft, status } = msg;
  const locked = status !== "pending";
  const ready = draftReady(draft);
  const faded = status === "discarded" || status === "undone";
  const border =
    status === "pending" || status === "applying"
      ? "border-dashed border-amber-500 dark:border-amber-700"
      : "border-solid";

  let applyLabel = "Apply";
  if (draft.op === "split") applyLabel = "Apply split";
  if (draft.op === "note") applyLabel = draft.currentNote ? "Replace note" : "Apply note";
  if (draft.op === "cat") applyLabel = "Apply category";
  if (draft.op === "cat_all") applyLabel = `Apply to ${draft.count} payment${draft.count === 1 ? "" : "s"}`;
  if (draft.op === "net") applyLabel = "Save net event";

  return (
    <div className={`${card} ${border} ${faded ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className={`rounded border px-1.5 py-px text-[10px] uppercase tracking-wide ${STATUS[status].chipClass}`}>
          {STATUS[status].chip}
        </span>
        <span className="text-[13px] font-semibold">{TITLE[draft.op]}</span>
        {txn && <span className="ml-auto font-mono text-[11px] text-neutral-500">{prettyDate(txn.txnDate)}</span>}
      </div>

      <div className="flex flex-col gap-2.5 p-3">
        {txn && (
          <div className="flex justify-between gap-2 text-[13px]">
            <span className="truncate font-medium">{txn.label}</span>
            <span className={`whitespace-nowrap font-mono text-xs ${txn.drCr === "debit" ? "text-spend" : "text-inflow"}`}>
              {formatPaiseSigned(txn.amountPaise, txn.drCr)}
            </span>
          </div>
        )}
        {draft.op === "split" && <SplitBody draft={draft} locked={locked} onChange={onChange} />}
        {draft.op === "note" && <NoteBody draft={draft} locked={locked} status={status} onChange={onChange} />}
        {draft.op === "cat" && <CatBody draft={draft} locked={locked} categories={categories} onChange={onChange} />}
        {draft.op === "cat_all" && (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            Sets <span className="font-medium">{categories.find((c) => c.id === draft.categoryId)?.name ?? "this category"}</span> on{" "}
            <span className="font-medium">
              {draft.count} other uncategorized payment{draft.count === 1 ? "" : "s"}
            </span>{" "}
            from {draft.payee}. Payments that already have a category aren&apos;t touched. New payments from this payee will
            default to it too.
          </p>
        )}
        {draft.op === "net" && <NetBody draft={draft} locked={locked} onChange={onChange} />}
        {msg.error && <p className="text-xs font-medium text-red-600">{msg.error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="mr-auto text-[11px] text-neutral-500">
          {status === "applied" ? "Saved to your account" : status === "pending" || status === "applying" ? "Not saved yet" : ""}
        </span>
        {(status === "pending" || status === "applying") && (
          <>
            <button type="button" disabled={status === "applying"} onClick={onDiscard} className={ghostButton}>
              Discard
            </button>
            <button type="button" disabled={!ready || status === "applying"} onClick={onApply} className={primaryButton}>
              {status === "applying" ? "Saving…" : applyLabel}
            </button>
          </>
        )}
        {(status === "applied" || status === "undoing") && (
          <button type="button" disabled={status === "undoing"} onClick={onUndo} className={outlineButton}>
            {status === "undoing" ? "Undoing…" : "Undo"}
          </button>
        )}
      </div>
    </div>
  );
}

type Draft<K extends OpDraft["op"]> = Extract<OpDraft, { op: K }>;

function SplitBody({ draft, locked, onChange }: { draft: Draft<"split">; locked: boolean; onChange: (d: OpDraft) => void }) {
  const bal = splitBalance(draft.totalPaise, draft.yourShare, draft.parts);
  const setPart = (i: number, patch: Partial<Draft<"split">["parts"][number]>) =>
    onChange({ ...draft, parts: draft.parts.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const equal = () => {
    const named = draft.parts.filter((p) => p.name.trim());
    if (named.length === 0) return;
    const { yours, each } = equalShares(draft.totalPaise, named.length);
    onChange({ ...draft, yourShare: rupeesString(yours), parts: named.map((p) => ({ ...p, amt: rupeesString(each) })) });
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className={label}>Total ₹</span>
          <input value={rupeesString(draft.totalPaise)} readOnly className={input} />
        </label>
        <label className="flex flex-col gap-1">
          <span className={label}>Your share ₹</span>
          <input
            value={draft.yourShare}
            readOnly={locked}
            placeholder="auto"
            inputMode="decimal"
            onChange={(e) => onChange({ ...draft, yourShare: e.target.value })}
            className={input}
          />
        </label>
      </div>
      <div className="flex items-center justify-between">
        <span className={label}>Participants</span>
        {!locked && (
          <button type="button" onClick={equal} className="text-[10px] uppercase tracking-wide text-neutral-500 underline underline-offset-2">
            Equal split
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {draft.parts.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={p.name}
              readOnly={locked}
              placeholder="Name"
              aria-label="Participant name"
              onChange={(e) => setPart(i, { name: e.target.value, known: false })}
              className={`${input} min-w-0 flex-1`}
            />
            {!p.known && p.name.trim() && !locked && (
              <span className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300">new</span>
            )}
            <input
              value={p.amt}
              readOnly={locked}
              placeholder="₹"
              inputMode="decimal"
              aria-label="Participant amount"
              onChange={(e) => setPart(i, { amt: e.target.value })}
              className={`${input} w-20`}
            />
            {!locked && (
              <button
                type="button"
                aria-label="Remove participant"
                onClick={() => onChange({ ...draft, parts: draft.parts.filter((_, j) => j !== i) })}
                className="text-xs text-neutral-500"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {!locked && (
          <button
            type="button"
            onClick={() => onChange({ ...draft, parts: [...draft.parts, { name: "", amt: "", known: false }] })}
            className="self-start text-xs text-neutral-500"
          >
            + Add participant
          </button>
        )}
      </div>
      <div className="text-xs text-neutral-500">
        Total {formatPaise(draft.totalPaise)} = your share {formatPaise(bal.yourSharePaise)} + participants{" "}
        {formatPaise(bal.participantsPaise)}{" "}
        {bal.invalid ? (
          <span className="font-medium text-red-600">(an amount isn&apos;t a valid ₹ value)</span>
        ) : bal.residualPaise !== 0 ? (
          <span className="font-medium text-red-600">
            ({bal.residualPaise > 0 ? "unaccounted" : "over by"} {formatPaise(Math.abs(bal.residualPaise))})
          </span>
        ) : null}
      </div>
    </>
  );
}

function NoteBody({
  draft,
  locked,
  status,
  onChange,
}: {
  draft: Draft<"note">;
  locked: boolean;
  status: OpMessage["status"];
  onChange: (d: OpDraft) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <span className={label}>{status === "applied" || status === "undone" ? "Previous note" : "Current note"}</span>
        <span className="text-xs italic text-neutral-500">{draft.currentNote || "— none —"}</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className={label}>New note</span>
        <textarea
          value={draft.note}
          readOnly={locked}
          rows={2}
          maxLength={500}
          placeholder="e.g. F1 TV subscription"
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
          className={`${input} resize-y`}
        />
      </label>
    </>
  );
}

function CatBody({
  draft,
  locked,
  categories,
  onChange,
}: {
  draft: Draft<"cat">;
  locked: boolean;
  categories: CategoryLite[];
  onChange: (d: OpDraft) => void;
}) {
  const prev = categories.find((c) => c.id === draft.currentCategoryId)?.name ?? "Uncategorized";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-neutral-500">{prev}</span>
      <span className="text-neutral-500">→</span>
      <select
        value={draft.categoryId}
        disabled={locked}
        onChange={(e) => onChange({ ...draft, categoryId: e.target.value })}
        className="rounded border border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs dark:border-neutral-700"
      >
        <option value="">— none —</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function NetLines({
  title,
  lines,
  locked,
  onChange,
}: {
  title: string;
  lines: NetLine[];
  locked: boolean;
  onChange: (lines: NetLine[]) => void;
}) {
  const total = lines.reduce((s, l) => s + (Number.isNaN(typedPaise(l.val)) ? 0 : typedPaise(l.val)), 0);
  const set = (i: number, val: string) => onChange(lines.map((l, j) => (j === i ? { ...l, val } : l)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="text-[11px] text-neutral-500">
          {lines.length} line{lines.length === 1 ? "" : "s"} · {formatPaise(total)}
        </span>
      </div>
      {lines.length === 0 && <p className="text-xs text-neutral-500">Nothing open.</p>}
      {lines.map((l, i) => {
        const paise = typedPaise(l.val);
        const bad = Number.isNaN(paise) || paise > l.outstandingPaise;
        return (
          <div key={l.id} className="flex items-center gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{l.person}</div>
              <div className="text-[11px] text-neutral-500">
                {l.date} · {l.desc} · outstanding {formatPaise(l.outstandingPaise)}
              </div>
            </div>
            <input
              value={l.val}
              readOnly={locked}
              placeholder="₹"
              inputMode="decimal"
              aria-label={`Amount for ${l.desc}`}
              onChange={(e) => set(i, e.target.value)}
              className={`${input} w-[76px] ${bad ? "!border-red-600" : ""}`}
            />
            {!locked && (
              <button
                type="button"
                onClick={() => set(i, rupeesString(l.outstandingPaise))}
                className="text-[10px] uppercase tracking-wide text-neutral-500"
              >
                All
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function NetBody({ draft, locked, onChange }: { draft: Draft<"net">; locked: boolean; onChange: (d: OpDraft) => void }) {
  const b = netBalance(draft.inflowPaise, draft.recv, draft.pay);
  let verdict: string;
  if (b.invalid) verdict = "✗ An amount isn't a valid ₹ value";
  else if (b.overLine) verdict = `✗ ${b.overLine.person} line exceeds outstanding`;
  else if (b.residualPaise === 0) verdict = "✓ Balanced";
  else
    verdict = `✗ Off by ${formatPaise(Math.abs(b.residualPaise))} — ${
      b.residualPaise > 0
        ? "net too high: reduce a receivable or increase a payable"
        : "net too low: increase a receivable or reduce a payable"
    }`;

  return (
    <>
      <div className="text-xs text-neutral-500">
        Inflow {formatPaise(draft.inflowPaise)} · Expected net {formatPaise(draft.inflowPaise)} · Person: {draft.person}
      </div>
      <NetLines title="They owe me" lines={draft.recv} locked={locked} onChange={(recv) => onChange({ ...draft, recv })} />
      <NetLines title="I owe them" lines={draft.pay} locked={locked} onChange={(pay) => onChange({ ...draft, pay })} />
      <div className="flex flex-col gap-0.5 rounded border border-neutral-200 px-2.5 py-2 text-xs dark:border-neutral-800">
        <div>Net = Σ receivables − Σ payables = {formatPaisePlain(b.receivablePaise - b.payablePaise)}</div>
        <div>Expected bank delta = {formatPaisePlain(draft.inflowPaise)}</div>
        <div className={`mt-0.5 ${b.ok ? "text-inflow" : "text-spend"}`}>{verdict}</div>
        {!locked && b.residualPaise !== 0 && !b.invalid && (
          <button
            type="button"
            onClick={() => onChange({ ...draft, recv: fillReceivablesLargestFirst(draft.inflowPaise, draft.recv, draft.pay) })}
            className="mt-1 self-start text-xs font-medium text-violet-700 underline dark:text-violet-300"
          >
            Adjust to match bank (prefer largest receivable)
          </button>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span className={label}>Note</span>
        <input
          value={draft.note}
          readOnly={locked}
          placeholder="optional"
          maxLength={200}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
          className={input}
        />
      </label>
    </>
  );
}
